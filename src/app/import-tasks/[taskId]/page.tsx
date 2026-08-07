"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";

type Task = {
  task_id: string;
  trace_id: string;
  file_name: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  throughput: number;
  eta_seconds: number | null;
  elapsed_seconds: number;
  completed_duration_seconds: number | null;
  degraded: boolean;
  degraded_reason: string | null;
  recent_errors: { error_code: string; error_reason: string; count: number }[];
};
type ErrorItem = { id: string; batch_index: number; row_number: number; field_name: string; raw_value: string | null; error_code: string; error_reason: string; suggestion: string | null; trace_id: string };

const statusMap: Record<string, { label: string; className: string }> = {
  pending: { label: "等待队列", className: "tag-orange" }, processing: { label: "处理中", className: "tag-teal" }, completed: { label: "已完成", className: "tag-green" }, partial_success: { label: "部分成功", className: "tag-orange" }, failed: { label: "失败", className: "tag-red" },
};

export default function ImportTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [errorCode, setErrorCode] = useState("");
  const [errorBatch, setErrorBatch] = useState("");
  const [errorPage, setErrorPage] = useState(1);
  const [errorTotal, setErrorTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadTask = useCallback(async (id: string) => {
    const response = await fetch(`/api/import-tasks/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("任务不存在");
    setTask(await response.json() as Task);
    setLoading(false);
  }, []);

  const loadErrors = useCallback(async (id: string, page: number, code: string, batch: string) => {
    const query = new URLSearchParams({ page: String(page), page_size: "12" });
    if (code) query.set("error_code", code);
    if (batch) query.set("batch", batch);
    const response = await fetch(`/api/import-tasks/${id}/errors?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { items: ErrorItem[]; total: number };
    setErrors(data.items); setErrorTotal(data.total);
  }, []);

  useEffect(() => { params.then(({ taskId: id }) => { setTaskId(id); void loadTask(id); void loadErrors(id, 1, "", ""); }); }, [params, loadTask, loadErrors]);
  useEffect(() => {
    if (!taskId || !task || ["completed", "partial_success", "failed"].includes(task.status)) return;
    const timer = window.setInterval(() => { void loadTask(taskId); void loadErrors(taskId, errorPage, errorCode, errorBatch); }, 2000);
    return () => window.clearInterval(timer);
  }, [taskId, task, loadTask, loadErrors, errorPage, errorCode, errorBatch]);

  const percent = useMemo(() => task ? Math.round((task.processed_rows / Math.max(task.total_rows, 1)) * 100) : 0, [task]);
  const durationLabel = formatDuration(task?.completed_duration_seconds ?? task?.elapsed_seconds ?? 0);
  const durationTitle = task?.completed_duration_seconds == null ? "已耗时" : "总耗时";
  const info = statusMap[task?.status || "pending"] || statusMap.pending;
  const errorPages = Math.max(1, Math.ceil(errorTotal / 12));

  if (loading || !task) return <div className="mx-auto max-w-6xl px-6 py-16 text-center text-[#86909c]"><Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-[#0fc6c2]" />正在加载导入任务...</div>;

  return <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6">
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div><Link href="/" className="btn-ghost mb-2 gap-1 px-0"><ArrowLeft className="h-4 w-4" />返回导入</Link><div className="flex items-center gap-3"><h1 className="text-2xl font-bold tracking-tight text-[#1d2129]">导入任务详情</h1><span className={`tag ${info.className}`}>{info.label}</span></div><p className="mt-1 text-sm text-[#86909c]">{task.file_name} · 任务 {task.task_id}</p></div>
      <button className="btn-outline" onClick={() => { void loadTask(taskId); void loadErrors(taskId, errorPage, errorCode, errorBatch); }}><RefreshCw className="h-4 w-4" />刷新</button>
    </div>
    {task.degraded && <div className="alert alert-warning mb-5 flex items-start gap-2"><AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" /><div><strong>SKU 校验已降级</strong><p className="text-xs">{task.degraded_reason || "本次导入未经过商品主数据完整校验，数据可能需要后续复核。"}</p></div></div>}

    <section className="card import-progress-card mb-5 overflow-hidden border-0">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.2em] text-[#8ec7c5]">Asynchronous Import / Live</p><p className="mt-2 text-4xl font-semibold tracking-tight">{percent}<span className="ml-1 text-xl text-[#8ec7c5]">%</span></p><p className="mt-1 text-sm text-[#b6cfce]">{task.processed_rows.toLocaleString()} / {task.total_rows.toLocaleString()} 行已处理</p></div><div className="text-right text-sm text-[#b6cfce]"><p>{durationTitle} <strong className="text-white">{durationLabel}</strong></p><p>当前吞吐 <strong className="text-white">{task.throughput.toLocaleString()} 行/分钟</strong></p><p>预计剩余 {task.eta_seconds == null ? "—" : formatDuration(task.eta_seconds)}</p><p>批次 {task.completed_batches} / {task.total_batches}</p></div></div>
      <div className="mt-6 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-[#70e1cf] transition-all duration-700" style={{ width: `${percent}%` }} /></div>
      <div className="mt-4 flex items-center justify-between text-xs text-[#8fb4b4]"><span>后台 Worker 自动消费，状态每 2 秒刷新</span><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#70e1cf]" />trace {task.trace_id}</span></div>
    </section>

    <div className="mb-5 grid gap-4 sm:grid-cols-4"><Metric label="成功入库" value={task.success_rows} tone="green" /><Metric label="失败行" value={task.failed_rows} tone="red" /><Metric label="批量单元" value={task.total_batches} tone="teal" /><Metric label="失败率" value={`${Math.round((task.failed_rows / Math.max(task.total_rows, 1)) * 10000) / 100}%`} tone="orange" /></div>

    <section className="card mb-5"><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">Error Observatory</p><h2 className="text-lg font-semibold">行级错误明细</h2></div><div className="flex flex-wrap gap-2"><select className="input-field w-32" value={errorBatch} onChange={(event) => { setErrorBatch(event.target.value); setErrorPage(1); void loadErrors(taskId, 1, errorCode, event.target.value); }}><option value="">全部批次</option>{Array.from({ length: task.total_batches }, (_, index) => <option key={index} value={String(index)}>批次 #{index + 1}</option>)}</select><select className="input-field w-36" value={errorCode} onChange={(event) => { setErrorCode(event.target.value); setErrorPage(1); void loadErrors(taskId, 1, event.target.value, errorBatch); }}><option value="">全部错误码</option><option value="E001">E001 · SKU 不存在</option><option value="E002">E002 · 必填缺失</option><option value="E003">E003 · 电话格式</option><option value="E004">E004 · 数量异常</option><option value="E005">E005 · 外部编码</option><option value="E006">E006 · 规则映射</option></select><a href={`/api/import-tasks/${taskId}/errors/export?${new URLSearchParams({ ...(errorBatch ? { batch: errorBatch } : {}), ...(errorCode ? { error_code: errorCode } : {}) }).toString()}`} className="btn-outline"><Download className="h-4 w-4" />导出 CSV</a><Link href={`/api/import-tasks/${taskId}/errors?page_size=100`} className="btn-outline" target="_blank"><ExternalLink className="h-4 w-4" />查看 JSON</Link></div></div>
      {errors.length === 0 ? <div className="rounded-lg bg-[#f7f8fa] py-10 text-center text-sm text-[#86909c]"><CheckCircle2 className="mx-auto mb-2 h-7 w-7 text-[#17c964]" />当前筛选条件下没有错误</div> : <><div className="table-wrapper"><table className="table-styled"><thead><tr><th>批次</th><th>行号</th><th>字段</th><th>错误码</th><th>原始值（脱敏）</th><th>错误原因 / 建议</th></tr></thead><tbody>{errors.map((item) => <tr key={item.id}><td>#{item.batch_index + 1}</td><td className="font-mono">{item.row_number}</td><td>{item.field_name}</td><td><span className="tag tag-red">{item.error_code}</span></td><td className="max-w-[180px] truncate font-mono text-xs">{item.raw_value || "—"}</td><td><div className="font-medium text-[#cf1322]">{item.error_reason}</div><div className="mt-1 text-xs text-[#86909c]">建议：{item.suggestion || "检查原始文件"}</div></td></tr>)}</tbody></table></div><div className="mt-3 flex items-center justify-between text-xs text-[#86909c]"><span>共 {errorTotal} 条错误</span><div className="flex items-center gap-2"><button className="btn-ghost px-2" disabled={errorPage <= 1} onClick={() => { const page = errorPage - 1; setErrorPage(page); void loadErrors(taskId, page, errorCode, errorBatch); }}>上一页</button><span>{errorPage} / {errorPages}</span><button className="btn-ghost px-2" disabled={errorPage >= errorPages} onClick={() => { const page = errorPage + 1; setErrorPage(page); void loadErrors(taskId, page, errorCode, errorBatch); }}>下一页</button></div></div></>}
    </section>

    <section className="grid gap-5 lg:grid-cols-[1fr_1fr]"><div className="card"><p className="eyebrow">Trace Search</p><h2 className="text-lg font-semibold">全链路追踪</h2><p className="mt-1 text-sm text-[#86909c]">上传 → Outbox → Queue → Worker → 批量校验 → 批量写入</p><div className="mt-4 flex gap-2"><input className="input-field font-mono text-xs" readOnly value={task.trace_id} /><Link href={`/traces/${task.trace_id}`} className="btn-primary whitespace-nowrap"><Search className="h-4 w-4" />检索</Link></div></div><div className="card"><p className="eyebrow">Latest Signals</p><h2 className="text-lg font-semibold">最近错误摘要</h2>{task.recent_errors.length === 0 ? <p className="mt-4 text-sm text-[#86909c]">暂无错误信号</p> : <div className="mt-3 space-y-2">{task.recent_errors.map((error) => <div className="flex items-center justify-between rounded-lg bg-[#f7f8fa] px-3 py-2 text-sm" key={`${error.error_code}-${error.error_reason}`}><span><span className="mr-2 font-mono text-[#cf1322]">{error.error_code}</span>{error.error_reason}</span><strong>{error.count}</strong></div>)}</div>}</div></section>
  </div>;
}

function formatDuration(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  const remainingSeconds = value % 60;
  if (minutes < 60) return `${minutes} 分 ${String(remainingSeconds).padStart(2, "0")} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone: "green" | "red" | "teal" | "orange" }) { return <div className="card border-l-4" style={{ borderLeftColor: tone === "green" ? "#17c964" : tone === "red" ? "#cf1322" : tone === "orange" ? "#f5a524" : "#0fc6c2" }}><p className="text-xs text-[#86909c]">{label}</p><p className="mt-1 text-2xl font-semibold text-[#1d2129]">{typeof value === "number" ? value.toLocaleString() : value}</p></div>; }
