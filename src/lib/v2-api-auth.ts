import { NextRequest, NextResponse } from "next/server";

/**
 * V2 对外只读 API（/api/v1/*）的鉴权与响应封装工具。
 * 仅供 V3 运单全流程管理系统调用；不影响 V2 既有页面与 Server Actions。
 */

// 401 未鉴权；统一错误体 { requestId, error: { code, message } }
export function unauthorizedResponse(requestId: string): NextResponse {
  return NextResponse.json(
    { requestId, error: { code: "UNAUTHORIZED", message: "缺少或错误的 X-API-Key" } },
    { status: 401 }
  );
}

// 透传 X-Request-ID；缺失则生成 req_<时间>-<随机>
export function getRequestId(req: NextRequest): string {
  const incoming = req.headers.get("x-request-id");
  if (incoming && incoming.trim()) return incoming.trim();
  const rand = Math.random().toString(36).slice(2, 10);
  return `req_${Date.now()}-${rand}`;
}

// 校验 X-API-Key 与 process.env.V2_API_KEY 是否一致
export function verifyV2ApiKey(req: NextRequest): boolean {
  const expected = process.env.V2_API_KEY;
  if (!expected) return false; // 未配置则一律拒绝，避免裸奔
  const provided = req.headers.get("x-api-key");
  return !!provided && provided === expected;
}

export function wrapV2Response<T>(requestId: string, data: T): NextResponse {
  return NextResponse.json({ requestId, data });
}

export function wrapV2Error(
  requestId: string,
  code: string,
  status: number,
  message: string
): NextResponse {
  return NextResponse.json(
    { requestId, error: { code, message } },
    { status }
  );
}

// 脱敏手机号：保留前 3 + **** + 后 4
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const s = String(phone).trim();
  if (s.length <= 7) return s; // 太短不脱敏，避免丢信息
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}
