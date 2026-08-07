# 大模型调用说明

> 本文档说明项目如何调用大模型（LLM）实现 AI 智能解析规则生成。

---

## 1. 功能概述

项目在**规则管理**模块中集成了大模型能力：用户上传 Excel/PDF 文件后，系统提取前 50 行 + 末 10 行作为样本，调用大模型分析文件结构并自动生成解析规则 JSON，用户确认微调后保存入库。该规则随后驱动异步导入链路的 `parse-engine.ts` 解析引擎。

**调用链路：**

```text
用户上传文件（规则管理页 /rules/new）
  → 前端提取行数据（前 50 行 + 末 10 行样本）
  → POST /api/ai/analyze（最多 500 行）
  → ai-client.ts: generateRule()
  → 构造 system prompt + user prompt
  → HTTPS POST 到大模型 API（OpenAI 兼容格式）
  → 解析返回的 JSON 规则
  → 返回前端，用户确认微调后保存
```

---

## 2. 大模型配置

项目使用 **OpenAI 兼容 API** 格式调用大模型，通过三个环境变量配置：

| 环境变量 | 说明 | 示例 |
|---|---|---|
| `DEEPSEEK_API_URL` | 大模型 API 端点地址 | `https://api.stepfun.com/v1/chat/completions` |
| `DEEPSEEK_API_KEY` | API 密钥（Bearer Token） | `sk-xxxxx` |
| `DEEPSEEK_MODEL` | 模型名称 | `step-router-v1` |

> 变量名含 `DEEPSEEK` 是历史命名，实际支持任何 OpenAI 兼容 API（DeepSeek、StepFun 等）。代码中通过 `apiUrl.includes("deepseek.com")` 判断是否为 DeepSeek 官方 API，仅官方 API 才追加 `response_format: { type: "json_object" }`，其他兼容 API 不追加以避免不兼容。

### Vercel 环境变量配置

在 `Vercel → V2 Project → Settings → Environment Variables` 中配置上述三个变量，作用域包含 Production。所有密钥只存环境变量，不入库、不提交 Git。

---

## 3. 核心文件

| 文件 | 职责 |
|---|---|
| [`src/lib/ai-client.ts`](../src/lib/ai-client.ts) | 大模型调用核心：构造 prompt、HTTPS 请求、解析返回 JSON |
| [`src/app/api/ai/analyze/route.ts`](../src/app/api/ai/analyze/route.ts) | API 路由：接收文件样本、调用 `generateRule()`、返回规则 |
| [`src/app/rules/new/page.tsx`](../src/app/rules/new/page.tsx) | 前端页面：上传文件、展示 AI 生成结果、用户确认微调 |

---

## 4. 调用细节

### 4.1 API 接口

```
POST /api/ai/analyze
Content-Type: application/json
```

**请求体：**
```json
{
  "rows": [...],        // RawRow[]，文件行数据（最多 500 行）
  "fileType": "excel",  // excel | pdf
  "fileName": "xxx.xlsx"
}
```

**响应体：**
```json
{
  "rule": {
    "name": "规则名称",
    "fileType": "excel",
    "parseMode": "standard",
    "excel": { "dataStartRow": 1, "headerRows": 0, "footerRows": 0 },
    "fieldMappings": [
      { "fromCol": 0, "toField": "externalCode", "aiConfidence": "high" }
    ],
    "defaults": {}
  },
  "suggestions": "分析说明文字",
  "confidenceSummary": { "high": 8, "medium": 1, "low": 1 }
}
```

**限制：**
- `maxDuration = 90` 秒（Vercel Function）
- 样本最多 500 行（超出返回 413）
- HTTPS 请求超时 60 秒

### 4.2 System Prompt

系统提示词定义在 `ai-client.ts` 的 `SYSTEM_PROMPT` 常量中，核心内容：

1. **角色**：物流发货单解析专家
2. **任务**：分析文件结构并生成解析规则 JSON
3. **输出格式**：纯 JSON 对象（不用 markdown 包裹）
4. **字段约束**：`toField` 必须是以下 10 个标准字段之一：`externalCode`、`storeName`、`receiverName`、`receiverPhone`、`receiverAddress`、`skuCode`、`skuName`、`skuQuantity`、`skuSpec`、`remark`
5. **解析模式**：支持 `standard`、`aggregate`、`matrix`、`card`、`multi-sheet` 五种模式
6. **置信度标记**：`high`（明确匹配）、`medium`（推测）、`low`（不确定）
7. **PDF 特殊处理**：PDF 已按文本 X 坐标对齐成表格网格，与 Excel 一样用 `fromCol` 列号映射
8. **KV 提取**：支持 `kvExtract` 配置提取非表格结构的键值对（如"收货人：张三"）

### 4.3 User Prompt

用户提示词由 `buildSamplePrompt()` 构造，包含：
- 文件名、文件类型、总行数
- 前 50 行样本数据（过滤空值后的 JSON 数组）
- 末 10 行样本数据（用于尾部信息分析，如合计行、收货信息）

### 4.4 请求参数

```json
{
  "model": "<DEEPSEEK_MODEL>",
  "messages": [
    { "role": "system", "content": "<SYSTEM_PROMPT>" },
    { "role": "user", "content": "<用户文件样本>" }
  ],
  "temperature": 0.1,
  "max_tokens": 16384
}
```

- `temperature: 0.1`：低温度保证输出稳定、确定性强
- `max_tokens: 16384`：允许输出完整规则 JSON
- 仅 DeepSeek 官方 API 追加 `"response_format": { "type": "json_object" }`

### 4.5 HTTPS 请求方式

使用 Node.js 原生 `https` 模块而非 `fetch`，原因是 Next.js 16 Turbopack 可能拦截路由内的 `fetch` 调用。请求头包含 `Authorization: Bearer <apiKey>` 和 `Content-Length`。

### 4.6 返回解析

大模型返回的 `choices[0].message.content` 可能是纯 JSON、markdown 包裹 JSON 或带前缀文字。`extractJson()` 函数按优先级尝试：
1. 匹配 ` ```json ... ``` ` 包裹内容
2. 直接 `JSON.parse`
3. 从第一个 `{` 截取到最后一个 `}` 再解析

---

## 5. 前端交互流程

1. 用户在 `/rules/new` 页面上传文件
2. 前端解析文件提取行数据，进入"AI 分析"步骤
3. 用户点击"AI 生成规则"按钮，前端 `POST /api/ai/analyze`
4. 后端调用大模型，返回规则 JSON
5. 前端展示 AI 生成结果和建议，用户可在"编辑"步骤微调
6. 用户也可跳过 AI 直接手动配置规则
7. 确认后保存规则到数据库 `parse_rules` 表

---

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 环境变量未配置 | 抛出明确错误提示（不静默 fallback） |
| API Key 错误（401） | 返回"AI 鉴权失败(401)：请确认 DEEPSEEK_API_KEY 正确无误" |
| 请求超时（60s） | 返回"AI 分析超时（60s）" |
| 返回内容为空 | 返回"AI 返回内容为空（请检查模型名、API Key 是否正确）" |
| JSON 解析失败 | 尝试 markdown 去包裹、花括号截取，仍失败则返回"AI 返回格式异常" |
| 样本超过 500 行 | 返回 413 "AI 分析样本最多支持 500 行" |

---

## 7. 与异步导入链路的关系

大模型生成的解析规则保存到数据库 `parse_rules` 表后，在异步导入链路中：

1. `POST /api/import-tasks` 接收 `parse_rule_id` 参数
2. Worker（`processImportFile`）从数据库读取该规则
3. `parse-engine.ts` 按规则的 `fieldMappings`、`parseMode`、`excel.dataStartRow` 等配置解析原文件
4. 规则是数据配置，非硬编码；同一规则可被多个导入任务复用

> AI 生成的规则与人工创建的规则在数据库中地位完全平等，`parse-engine.ts` 不区分规则来源。