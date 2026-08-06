"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, FileSearch, Filter, RotateCcw, Search } from "lucide-react";

type TraceResult = {
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
  created_at: string;
  completed_at: string | null;
  rule_name: string | null;
  trace_event_count: number;
  outbox_count: number;
  error_count: number;
  matched_error_count: number;
};

type Filters = { task_id: string; trace_id: string; file_name: string; batch: string; row_from: string; row_to: string; error_code: string };
const emptyFilters: Filters = { task_id: "", trace_id: "", file_name: "", batch: "", row_from: "", row_to: "", error_code: "" };
const statusLabel: Record<string, string> = { pending: "等待处理", processing: "处理中", completed: "已完成", partial_success: "部分成功", failed: "失败" };

export default function TraceSearchPage() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [items, setItems] = useState<TraceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const update = (name: keyof Filters, value: string) => setFilters((current) => ({ ...current, [name]: value }));

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true); setError(""); setSearched(true);
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value.trim()) query.set(key, value.trim()); });
    try {
      const response = await fetch(`/api/traces/search?${query.toString()}`, { cache: "no-store" });
      const data = await response.json() as { items?: TraceResult[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Trace 搜索失败");
      setItems(data.items || []);
    } catch (cause) {
      setItems([]); setError(cause instanceof Error ? cause.message : "Trace 搜索失败");
    } finally { setLoading(false); }
  }

  function detailHref(item: TraceResult) {
    const query = new URLSearchParams();
    for (const key of ["batch", "row_from", "row_to", "error_code"] as const) if (filters[key]) query.set(key, filters[key]);
    const suffix = query.toString();
    return `/traces/${item.trace_id}${suffix ? `?${suffix}` : ""}`;
  }

  return <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <header className="mb-7 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
      <div><p className="eyebrow">Observability / Trace explorer</p><h1 className="mt-1 text-3xl font-bold tracking-tight text-[#1d2129]">全链路 Trace 检索</h1><p className="mt-2 max-w-3xl text-sm text-[#4e5969]">按任务、链路、文件、批次、行号和错误码定位导入记录，在一条时间线上还原 API → Outbox → Queue → Worker → DB。</p></div>
      <div className="flex items-center gap-2 rounded-xl border border-[#d0e8e8] bg-[#e8fafa] px-4 py-3 text-sm text-[#0b6e6e]"><Activity className="h-4 w-4" />目标 MTTD ≤ 1 分钟</div>
    </header>

    <form onSubmit={search} className="card mb-6 border border-[#e5e6eb]">
      <div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">Search dimensions</p><h2 className="text-lg font-semibold">六维定位条件</h2></div><Filter className="h-5 w-5 text-[#0b6e6e]" /></div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Field label="task_id" value={filters.task_id} placeholder="任务 UUID" onChange={(v) => update("task_id", v)} wide />
        <Field label="trace_id" value={filters.trace_id} placeholder="链路 UUID" onChange={(v) => update("trace_id", v)} wide />
        <Field label="文件名" value={filters.file_name} placeholder="支持模糊搜索" onChange={(v) => update("file_name", v)} />
        <Field label="批次号" value={filters.batch} placeholder="从 1 开始" type="number" onChange={(v) => update("batch", v)} />
        <Field label="起始行号" value={filters.row_from} placeholder="例如 1" type="number" onChange={(v) => update("row_from", v)} />
        <Field label="结束行号" value={filters.row_to} placeholder="例如 1000" type="number" onChange={(v) => update("row_to", v)} />
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-[#4e5969]">错误码</span><select className="input-field" value={filters.error_code} onChange={(e) => update("error_code", e.target.value)}><option value="">全部错误码</option>{["E001","E002","E003","E004","E005","E006"].map((code) => <option key={code}>{code}</option>)}</select></label>
      </div>
      <div className="mt-5 flex flex-wrap gap-2"><button className="btn-primary" disabled={loading}><Search className="h-4 w-4" />{loading ? "检索中..." : "开始检索"}</button><button type="button" className="btn-outline" onClick={() => { setFilters(emptyFilters); setItems([]); setSearched(false); setError(""); }}><RotateCcw className="h-4 w-4" />重置</button></div>
    </form>

    {error && <div className="alert alert-danger mb-5">{error}</div>}
    {!searched ? <div className="card border border-dashed border-[#b5e8e8] py-14 text-center"><FileSearch className="mx-auto mb-3 h-9 w-9 text-[#0fc6c2]" /><h2 className="font-semibold text-[#1d2129]">输入任意条件开始定位</h2><p className="mt-1 text-sm text-[#86909c]">条件可组合；不填条件可查看最近 50 个导入任务。</p></div> : items.length === 0 && !loading ? <div className="card py-14 text-center text-[#86909c]">没有匹配的导入 Trace</div> : <section>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">检索结果</h2><span className="text-xs text-[#86909c]">最多返回 50 条 · 当前 {items.length} 条</span></div>
      <div className="grid gap-3">{items.map((item) => <Link key={item.task_id} href={detailHref(item)} className="group card border border-[#e5e6eb] no-underline transition hover:border-[#0fc6c2]">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(110px,.5fr))_auto] lg:items-center">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold text-[#1d2129]">{item.file_name}</span><span className={`tag ${item.status === "failed" ? "tag-red" : item.status === "completed" ? "tag-green" : "tag-orange"}`}>{statusLabel[item.status] || item.status}</span></div><p className="mt-1 truncate font-mono text-xs text-[#86909c]">task {item.task_id}</p><p className="truncate font-mono text-xs text-[#86909c]">trace {item.trace_id}</p></div>
          <Stat label="处理进度" value={`${item.processed_rows.toLocaleString()} / ${item.total_rows.toLocaleString()}`} />
          <Stat label="链路证据" value={`${item.trace_event_count} events`} />
          <Stat label="错误命中" value={`${item.matched_error_count || item.error_count} rows`} danger={(item.matched_error_count || item.error_count) > 0} />
          <ArrowRight className="h-5 w-5 text-[#86909c] transition group-hover:translate-x-1 group-hover:text-[#0b6e6e]" />
        </div>
      </Link>)}</div>
    </section>}
  </div>;
}

function Field({ label, value, placeholder, type = "text", onChange, wide = false }: { label: string; value: string; placeholder: string; type?: string; onChange: (value: string) => void; wide?: boolean }) { return <label className={`block ${wide ? "xl:col-span-2" : ""}`}><span className="mb-1.5 block text-xs font-medium text-[#4e5969]">{label}</span><input className="input-field font-mono text-xs" type={type} min={type === "number" ? 1 : undefined} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>; }
function Stat({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) { return <div><p className="text-xs text-[#86909c]">{label}</p><p className={`mt-1 font-mono text-sm font-semibold ${danger ? "text-[#cf1322]" : "text-[#1d2129]"}`}>{value}</p></div>; }
