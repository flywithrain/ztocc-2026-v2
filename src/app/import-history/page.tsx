"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock3, FileClock, Filter, RotateCcw, Search } from "lucide-react";

type HistoryItem = {
  task_id: string;
  trace_id: string;
  file_name: string;
  status: string;
  processing_stage: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  degraded: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  rule_name: string | null;
  trace_event_count: number;
  error_count: number;
  dlq_count: number;
};
type HistoryData = { page: number; page_size: number; total: number; summary: { total: number; processing: number; completed: number; partial_success: number; failed: number }; items: HistoryItem[] };
type Filters = { task_id: string; trace_id: string; file_name: string; status: string };
const blank: Filters = { task_id: "", trace_id: "", file_name: "", status: "" };
const statusLabels: Record<string, string> = { pending: "等待", processing: "处理中", completed: "已完成", partial_success: "部分成功", failed: "失败" };

export default function ImportHistoryPage() {
  const [filters, setFilters] = useState<Filters>(blank);
  const [data, setData] = useState<HistoryData | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (targetPage: number, currentFilters: Filters) => {
    setLoading(true); setError("");
    const query = new URLSearchParams({ page: String(targetPage), page_size: "20" });
    Object.entries(currentFilters).forEach(([key, value]) => { if (value.trim()) query.set(key, value.trim()); });
    try {
      const response = await fetch(`/api/import-history?${query.toString()}`, { cache: "no-store" });
      const body = await response.json() as HistoryData & { error?: string };
      if (!response.ok) throw new Error(body.error || "导入历史查询失败");
      setData(body); setPage(targetPage);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导入历史查询失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(1, blank); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  function submit(event: FormEvent) { event.preventDefault(); void load(1, filters); }
  function update(name: keyof Filters, value: string) { setFilters((current) => ({ ...current, [name]: value })); }
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / 20));

  return <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <header className="mb-7 flex flex-wrap items-end justify-between gap-5"><div><p className="eyebrow">Operations / Import history</p><h1 className="mt-1 text-3xl font-bold tracking-tight text-[#1d2129]">导入历史</h1><p className="mt-2 text-sm text-[#4e5969]">所有异步导入任务的可查询记录。每条记录同时提供 task_id、trace_id、任务详情和 Trace 链路入口。</p></div><Link href="/import-monitor" className="btn-outline"><Clock3 className="h-4 w-4" />返回监控台</Link></header>

    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Summary label="全部任务" value={data?.summary.total || 0} /><Summary label="处理中" value={data?.summary.processing || 0} tone="teal" /><Summary label="已完成" value={data?.summary.completed || 0} tone="green" /><Summary label="部分成功" value={data?.summary.partial_success || 0} tone="orange" /><Summary label="失败" value={data?.summary.failed || 0} tone="red" /></div>

    <form onSubmit={submit} className="card mb-6 border border-[#e5e6eb]"><div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">History filters</p><h2 className="text-lg font-semibold">筛选导入记录</h2></div><Filter className="h-5 w-5 text-[#0b6e6e]" /></div><div className="grid gap-4 lg:grid-cols-4"><Field label="文件名" placeholder="支持模糊搜索" value={filters.file_name} onChange={(v) => update("file_name", v)} /><Field label="task_id" placeholder="任务 UUID" value={filters.task_id} onChange={(v) => update("task_id", v)} mono /><Field label="trace_id" placeholder="链路 UUID" value={filters.trace_id} onChange={(v) => update("trace_id", v)} mono /><label className="block"><span className="mb-1.5 block text-xs font-medium text-[#4e5969]">状态</span><select className="input-field" value={filters.status} onChange={(e) => update("status", e.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div><div className="mt-5 flex gap-2"><button className="btn-primary" disabled={loading}><Search className="h-4 w-4" />{loading ? "查询中..." : "查询历史"}</button><button type="button" className="btn-outline" onClick={() => { setFilters(blank); void load(1, blank); }}><RotateCcw className="h-4 w-4" />重置</button></div></form>

    {error && <div className="alert alert-danger mb-5">{error}</div>}
    <section className="card border border-[#e5e6eb] p-0"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e6eb] px-5 py-4"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e8fafa] text-[#0b6e6e]"><FileClock className="h-5 w-5" /></div><div><h2 className="font-semibold">导入记录</h2><p className="text-xs text-[#86909c]">第 {page} / {totalPages} 页 · 共 {data?.total || 0} 条</p></div></div><span className="text-xs text-[#86909c]">Trace 可直接进入全链路诊断</span></div><div className="overflow-x-auto">{loading && !data ? <div className="py-16 text-center text-sm text-[#86909c]">正在读取导入历史...</div> : data?.items.length === 0 ? <div className="py-16 text-center text-sm text-[#86909c]">没有匹配的导入记录</div> : <table className="table-styled min-w-[1120px]"><thead><tr><th>文件与状态</th><th>task_id</th><th>trace_id</th><th>处理进度</th><th>错误 / Trace</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{data?.items.map((item) => <tr key={item.task_id}><td><div className="font-medium text-[#1d2129]">{item.file_name}</div><div className="mt-1"><span className={`tag ${item.status === "failed" ? "tag-red" : item.status === "completed" ? "tag-green" : item.status === "partial_success" ? "tag-orange" : "tag-teal"}`}>{statusLabels[item.status] || item.status}</span>{item.degraded && <span className="ml-2 tag tag-orange">已降级</span>}</div></td><td className="max-w-[190px] font-mono text-[11px]" title={item.task_id}>{item.task_id}</td><td className="max-w-[190px] font-mono text-[11px]" title={item.trace_id}>{item.trace_id}</td><td><div>{item.processed_rows.toLocaleString()} / {item.total_rows.toLocaleString()} 行</div><div className="mt-1 text-xs text-[#86909c]">成功 {item.success_rows.toLocaleString()} · 失败 {item.failed_rows.toLocaleString()} · 批次 {item.completed_batches}/{item.total_batches}</div></td><td><div className={item.error_count > 0 ? "text-[#cf1322]" : "text-[#17c964]"}>{item.error_count.toLocaleString()} 条错误</div><div className="text-xs text-[#86909c]">{item.trace_event_count} 个 Trace 事件{item.dlq_count ? ` · DLQ ${item.dlq_count}` : ""}</div></td><td className="whitespace-nowrap text-xs text-[#86909c]">{new Date(item.created_at).toLocaleString("zh-CN", { hour12: false })}</td><td><div className="flex flex-col gap-2"><Link href={`/import-tasks/${item.task_id}`} className="btn-outline !px-3 !py-1.5 text-xs">任务详情</Link><Link href={`/traces/${item.trace_id}`} className="btn-primary !px-3 !py-1.5 text-xs"><ArrowRight className="h-3.5 w-3.5" />Trace 链路</Link></div></td></tr>)}</tbody></table>}</div><div className="flex items-center justify-between border-t border-[#e5e6eb] px-5 py-4 text-sm"><span className="text-xs text-[#86909c]">支持按文件名、task_id、trace_id 和状态筛选</span><div className="flex items-center gap-2"><button className="btn-ghost px-3" disabled={page <= 1 || loading} onClick={() => void load(page - 1, filters)}>上一页</button><span className="text-xs text-[#4e5969]">{page} / {totalPages}</span><button className="btn-ghost px-3" disabled={page >= totalPages || loading} onClick={() => void load(page + 1, filters)}>下一页</button></div></div></section>
  </div>;
}

function Summary({ label, value, tone = "gray" }: { label: string; value: number; tone?: string }) { const colors: Record<string, string> = { teal: "#0b6e6e", green: "#17c964", orange: "#d97b00", red: "#cf1322", gray: "#1d2129" }; return <div className="card border border-[#e5e6eb]"><p className="text-xs text-[#86909c]">{label}</p><p className="mt-1 text-2xl font-semibold" style={{ color: colors[tone] }}>{value.toLocaleString()}</p></div>; }
function Field({ label, placeholder, value, onChange, mono = false }: { label: string; placeholder: string; value: string; onChange: (value: string) => void; mono?: boolean }) { return <label className="block"><span className="mb-1.5 block text-xs font-medium text-[#4e5969]">{label}</span><input className={`input-field ${mono ? "font-mono text-xs" : ""}`} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
