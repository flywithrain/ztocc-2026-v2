"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, Clock3, Database, FileArchive, Inbox, Loader2, Search, ServerCog } from "lucide-react";

type TraceEvent = { id: string; task_id: string; unit_id: string | null; event_name: string; event_status: string; message: string; metadata: Record<string, unknown> | null; occurred_at: string };
type Outbox = { id: string; event_type: string; status: string; provider: string; provider_message_id: string | null; retry_count: number; last_error: string | null; unit_id: string | null; created_at: string; sent_at: string | null; dead_lettered_at: string | null };
type Batch = { id: string; unit_id: string; batch_index: number; start_row: number; end_row: number; status: string; retry_count: number; processed_rows: number; success_rows: number; failed_rows: number; qstash_message_id: string | null; delivery_attempt: number; queued_at: string | null; last_delivery_at: string | null; locked_at: string | null; completed_at: string | null; last_error: string | null };
type Performance = { unit_id: string; batch_index: number; parse_duration_ms: number; rule_duration_ms: number; validate_duration_ms: number; insert_duration_ms: number; total_duration_ms: number; status: string; created_at: string };
type TraceError = { id: string; unit_id: string; batch_index: number; row_number: number; field_name: string; raw_value: string | null; error_code: string; error_reason: string; suggestion: string | null; created_at: string };
type Task = { task_id: string; trace_id: string; file_name: string; file_hash: string; file_mime: string | null; file_size: number | null; source_blob_pathname: string | null; source_blob_saved: boolean; parse_rule_id: string; rule_name: string | null; status: string; processing_stage: string; total_rows: number; processed_rows: number; success_rows: number; failed_rows: number; total_batches: number; completed_batches: number; degraded: boolean; degraded_reason: string | null; created_at: string; parsed_at: string | null; started_at: string | null; completed_at: string | null };
type TraceData = { trace_id: string; task: Task; filters: { batch: number | null; row_from: number | null; row_to: number | null; error_code: string | null }; events: TraceEvent[]; outbox: Outbox[]; batches: Batch[]; performance: Performance[]; errors: TraceError[]; db_writes: { shipment_count: number; order_count: number } };

const labels: Record<string, string> = {
  ImportApiAccepted: "API 接收文件", ImportIdentifiersGenerated: "生成任务标识", ImportFileReferenceSaved: "保存原文件引用", ImportRowCountPrescanned: "预扫描总行数", ImportTaskRecordCreated: "创建任务记录",
  ImportFileUploaded: "原文件已上传", QStashPublished: "QStash 入队", QStashPublishFailed: "QStash 发布失败", ImportQueueConsumed: "Worker 消费消息", ImportFileParsed: "文件解析完成", ImportFileParseFailed: "文件解析失败",
  ImportBatchStarted: "批次开始", ImportBatchValidated: "批量校验完成", ImportDatabaseWritten: "数据库批量写入", ImportBatchSucceeded: "批次完成", ImportBatchFailed: "批次失败", QStashDeadLettered: "消息进入 DLQ",
  ImportTaskCompleted: "任务完成", ImportTaskPartialSuccess: "任务部分成功", ImportTaskDegraded: "SKU 校验降级", ImportBlobsDeleted: "Blob 已清理", ImportTaskCreated: "任务创建",
};

export default function TracePage({ params, searchParams }: { params: Promise<{ traceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [traceId, setTraceId] = useState("");
  const [data, setData] = useState<TraceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([params, searchParams]).then(async ([route, query]) => {
      setTraceId(route.traceId);
      const qs = new URLSearchParams();
      for (const key of ["batch", "row_from", "row_to", "error_code"]) {
        const value = query[key]; if (typeof value === "string" && value) qs.set(key, value);
      }
      try {
        const response = await fetch(`/api/traces/${route.traceId}?${qs.toString()}`, { cache: "no-store" });
        const body = await response.json() as TraceData & { error?: string };
        if (!response.ok) throw new Error(body.error || "Trace 不存在");
        setData(body);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Trace 加载失败"); }
      finally { setLoading(false); }
    });
  }, [params, searchParams]);

  const perfByUnit = useMemo(() => new Map((data?.performance || []).map((item) => [item.unit_id, item])), [data]);
  const batchByUnit = useMemo(() => new Map((data?.batches || []).map((item) => [item.unit_id, item])), [data]);

  if (loading) return <div className="mx-auto max-w-6xl px-6 py-16 text-center text-[#86909c]"><Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-[#0fc6c2]" />正在聚合 API、Outbox、Queue、Worker 与 DB 证据...</div>;
  if (error || !data) return <div className="mx-auto max-w-4xl px-6 py-12"><div className="alert alert-danger">{error || "Trace 不存在"}</div><Link href="/traces" className="btn-outline mt-4">返回 Trace 检索</Link></div>;
  const { task } = data;

  return <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <Link href="/traces" className="btn-ghost mb-4 gap-1 px-0"><ArrowLeft className="h-4 w-4" />返回 Trace 检索</Link>
    <header className="mb-6 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-start">
      <div><p className="eyebrow">Trace timeline / Diagnosis</p><div className="mt-1 flex flex-wrap items-center gap-3"><h1 className="text-2xl font-bold text-[#1d2129]">{task.file_name}</h1><span className={`tag ${task.status === "failed" ? "tag-red" : task.status === "completed" ? "tag-green" : "tag-orange"}`}>{task.status}</span></div><p className="mt-2 break-all font-mono text-xs text-[#86909c]">task_id {task.task_id}</p><p className="break-all font-mono text-xs text-[#86909c]">trace_id {traceId}</p></div>
      <Link href={`/import-tasks/${task.task_id}`} className="btn-outline"><Activity className="h-4 w-4" />查看导入记录</Link>
    </header>

    <section className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <Stage icon={Search} step="API" title="接收与建档" detail={`${task.total_rows.toLocaleString()} 行预扫描`} ok={Boolean(task.task_id && task.trace_id)} />
      <Stage icon={FileArchive} step="Blob" title="原文件引用" detail={task.source_blob_saved ? "可复读引用已保存" : "旧任务兼容载荷"} ok={task.source_blob_saved} />
      <Stage icon={Inbox} step="Outbox" title="可靠事件" detail={`${data.outbox.length} 条 · ${data.outbox.filter((x) => x.status === "sent").length} 已投递`} ok={data.outbox.length > 0} />
      <Stage icon={ServerCog} step="Queue / Worker" title="QStash 消费" detail={`${data.batches.length} 批 · ${data.batches.reduce((n, x) => n + x.delivery_attempt, 0)} 次 delivery`} ok={data.batches.length > 0} />
      <Stage icon={Database} step="DB" title="批量入库" detail={`${Number(data.db_writes.shipment_count).toLocaleString()} 运单 · ${Number(data.db_writes.order_count).toLocaleString()} 明细`} ok={task.processed_rows > 0} />
    </section>

    <section className="card mb-6 border border-[#e5e6eb]"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Task record</p><h2 className="text-lg font-semibold">导入记录与可复读证据</h2></div><span className="font-mono text-xs text-[#86909c]">{task.processing_stage}</span></div>
      <div className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4"><Info label="解析规则" value={`${task.rule_name || "未命名规则"} (${task.parse_rule_id})`} /><Info label="文件引用" value={task.source_blob_pathname || "旧任务 file_payload"} mono /><Info label="文件信息" value={`${task.file_mime || "未知类型"} · ${formatBytes(task.file_size)}`} /><Info label="SHA-256" value={task.file_hash} mono /><Info label="总行数 / 已处理" value={`${task.total_rows.toLocaleString()} / ${task.processed_rows.toLocaleString()}`} /><Info label="成功 / 失败" value={`${task.success_rows.toLocaleString()} / ${task.failed_rows.toLocaleString()}`} /><Info label="批次" value={`${task.completed_batches} / ${task.total_batches}`} /><Info label="任务创建" value={formatTime(task.created_at)} /></div>
      {task.degraded && <div className="alert alert-warning mt-4"><AlertTriangle className="mr-2 inline h-4 w-4" />{task.degraded_reason}</div>}
    </section>

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,.6fr)]">
      <section><div className="mb-3 flex items-center justify-between"><div><p className="eyebrow">Ordered events</p><h2 className="text-lg font-semibold">全链路时间线</h2></div><span className="text-xs text-[#86909c]">{data.events.length} 个 Trace 事件</span></div>
        <div className="relative ml-3 border-l-2 border-[#d0e8e8] pl-8">{data.events.map((event) => <article className="relative mb-4 last:mb-0" key={event.id}><span className={`absolute -left-[43px] top-4 flex h-6 w-6 items-center justify-center rounded-full border-4 border-[#f7f8fa] ${event.event_status === "failed" ? "bg-[#cf1322]" : event.event_status === "warning" ? "bg-[#f5a524]" : "bg-[#0fc6c2]"} text-white`}>{event.event_status === "failed" ? <CircleAlert className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}</span><div className="card border border-[#e5e6eb] !p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><strong>{labels[event.event_name] || event.event_name}</strong>{event.unit_id && <span className="ml-2 font-mono text-xs text-[#86909c]">{event.unit_id}</span>}</div><span className="flex items-center gap-1 text-xs text-[#86909c]"><Clock3 className="h-3 w-3" />{formatTime(event.occurred_at)}</span></div><p className={`mt-2 text-sm ${event.event_status === "failed" ? "text-[#cf1322]" : "text-[#4e5969]"}`}>{event.message}</p>{event.metadata && <pre className="mt-3 overflow-x-auto rounded-lg bg-[#f7f8fa] p-3 text-[11px] leading-5 text-[#4e5969]">{JSON.stringify(event.metadata, null, 2)}</pre>}</div></article>)}</div>
      </section>

      <aside className="space-y-5"><Panel eyebrow="Outbox / QStash" title="队列投递记录"><div className="space-y-2">{data.outbox.map((item) => <div key={item.id} className="rounded-lg border border-[#e5e6eb] p-3 text-xs"><div className="flex justify-between gap-2"><strong>{item.event_type}</strong><span className={item.status === "sent" ? "text-[#17c964]" : "text-[#cf1322]"}>{item.status}</span></div><p className="mt-1 font-mono text-[#86909c]">{item.unit_id || "task-level"}</p><p className="break-all text-[#4e5969]">message {item.provider_message_id || "尚未生成"}</p><p className="text-[#86909c]">retry {item.retry_count} · {formatTime(item.sent_at || item.created_at)}</p>{item.last_error && <p className="mt-1 text-[#cf1322]">{item.last_error}</p>}</div>)}</div></Panel>
        <Panel eyebrow="Batch performance" title="Worker 与 DB 阶段耗时"><div className="space-y-2">{data.performance.map((item) => <div key={item.unit_id} className="rounded-lg bg-[#f7f8fa] p-3 text-xs"><div className="flex justify-between"><strong>{item.unit_id}</strong><strong>{item.total_duration_ms} ms</strong></div><div className="mt-2 grid grid-cols-2 gap-1 text-[#4e5969]"><span>校验 {item.validate_duration_ms} ms</span><span>写入 {item.insert_duration_ms} ms</span><span>解析 {item.parse_duration_ms} ms</span><span>规则 {item.rule_duration_ms} ms</span></div></div>)}</div></Panel>
      </aside>
    </div>

    <section className="mt-7"><div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">Failure diagnosis</p><h2 className="text-lg font-semibold">失败节点与行级定位</h2><p className="mt-1 text-sm text-[#86909c]">展示批次、行号、字段、脱敏原值、规则、耗时、重试与修复建议。</p></div>{data.filters.error_code && <span className="tag tag-red">筛选 {data.filters.error_code}</span>}</div>
      {data.errors.length === 0 ? <div className="card py-10 text-center text-sm text-[#86909c]"><CheckCircle2 className="mx-auto mb-2 h-7 w-7 text-[#17c964]" />当前条件下无行级错误</div> : <div className="grid gap-3">{data.errors.map((item) => { const perf = perfByUnit.get(item.unit_id); const batch = batchByUnit.get(item.unit_id); return <details key={item.id} className="card border border-[#ffd4d0] open:border-[#cf1322]"><summary className="flex cursor-pointer list-none flex-wrap items-center gap-3"><span className="tag tag-red">{item.error_code}</span><strong>第 {item.row_number} 行 · {item.field_name}</strong><span className="font-mono text-xs text-[#86909c]">批次 #{item.batch_index + 1} / {item.unit_id}</span><span className="ml-auto text-sm text-[#cf1322]">{item.error_reason}</span></summary><div className="mt-4 grid gap-3 border-t border-[#ffe2df] pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4"><Info label="脱敏原始值" value={item.raw_value || "—"} mono /><Info label="所属规则" value={`${task.rule_name || "未命名规则"} · ${task.parse_rule_id}`} /><Info label="阶段耗时" value={perf ? `校验 ${perf.validate_duration_ms}ms / DB ${perf.insert_duration_ms}ms / 总计 ${perf.total_duration_ms}ms` : "暂无性能日志"} /><Info label="是否重试" value={`批次重试 ${batch?.retry_count || 0} 次 / QStash delivery ${batch?.delivery_attempt || 0}`} /><Info label="错误原因" value={item.error_reason} /><Info label="下一步建议" value={item.suggestion || "检查原始文件与解析规则"} /><Info label="行号范围" value={batch ? `${batch.start_row + 1} - ${batch.end_row}` : "—"} /><Info label="QStash message" value={batch?.qstash_message_id || "—"} mono /></div></details>; })}</div>}
    </section>
  </div>;
}

function Stage({ icon: Icon, step, title, detail, ok }: { icon: typeof Search; step: string; title: string; detail: string; ok: boolean }) { return <div className={`card border ${ok ? "border-[#b5e8e8]" : "border-[#ffe4ba]"}`}><div className="flex items-center justify-between"><Icon className={`h-5 w-5 ${ok ? "text-[#0b6e6e]" : "text-[#d97b00]"}`} /><span className="font-mono text-[10px] uppercase tracking-wider text-[#86909c]">{step}</span></div><p className="mt-3 font-semibold text-[#1d2129]">{title}</p><p className="mt-1 text-xs text-[#86909c]">{detail}</p></div>; }
function Panel({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) { return <section className="card border border-[#e5e6eb]"><p className="eyebrow">{eyebrow}</p><h2 className="mb-3 text-base font-semibold">{title}</h2>{children}</section>; }
function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0"><p className="text-xs text-[#86909c]">{label}</p><p className={`mt-1 break-all text-[#1d2129] ${mono ? "font-mono text-xs" : "text-sm"}`}>{value}</p></div>; }
function formatTime(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function formatBytes(value: number | null) { if (!value) return "—"; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 / 1024).toFixed(2)} MiB`; }
