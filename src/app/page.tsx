"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { FileUploadZone } from "@/components/upload/file-upload-zone";
import { RuleSelector } from "@/components/upload/rule-selector";
import { ProgressBar } from "@/components/shared/progress-bar";
import { useToast } from "@/components/shared/toast";
import { upload } from "@vercel/blob/client";
import { readFile } from "@/lib/file-reader";
import { buildSourceBlobPath } from "@/lib/blob-paths";
import { parseFile } from "@/lib/parse-engine";
import { validateOrders, checkExternalCodeDuplicates, checkReceiverConsistency } from "@/lib/validators";
import { getAllRules, getExistingExternalCodes } from "@/lib/server-actions";
import type { ParsedFile, ParseRule, ParseProgress } from "@/types";
import { Sparkles, FileText, ArrowRight, Database, Zap } from "lucide-react";

const LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024;

type SourceBlob = { url: string; pathname: string; contentType: string; size: number; fileHash: string };

export default function HomePage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null);
  const [sourceBlob, setSourceBlob] = useState<SourceBlob | null>(null);
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [selectedRule, setSelectedRule] = useState<ParseRule | null>(null);
  const [progress, setProgress] = useState<ParseProgress>({ current: 0, total: 0, percent: 0, status: "idle" });
  const [loading, setLoading] = useState(false);

  const isLargeFile = Boolean(file && file.size > LARGE_FILE_THRESHOLD_BYTES);

  const handleFileSelected = useCallback(async (nextFile: File) => {
    setFile(nextFile);
    setParsedFile(null);
    setSourceBlob(null);
    setSelectedRule(null);
    setProgress({ current: 0, total: 0, percent: 0, status: "idle" });
    setLoading(true);

    try {
      const large = nextFile.size > LARGE_FILE_THRESHOLD_BYTES;
      setProgress({ current: 0, total: 1, percent: 5, status: "parsing" });
      const digestPromise = nextFile.arrayBuffer().then((buffer) => crypto.subtle.digest("SHA-256", buffer));
      const parsedPromise = large ? Promise.resolve(null) : readFile(nextFile);
      const [digest, parsed] = await Promise.all([digestPromise, parsedPromise]);
      setParsedFile(parsed);
      setProgress({ current: 0, total: 1, percent: 25, status: "parsing" });

      const blob = await upload(buildSourceBlobPath(nextFile.name), nextFile, {
        access: "private",
        handleUploadUrl: "/api/import-files/upload",
        multipart: nextFile.size > 5 * 1024 * 1024,
        contentType: nextFile.type || undefined,
        onUploadProgress: ({ percentage }) => {
          setProgress({ current: 0, total: 1, percent: 25 + Math.round(percentage * 65), status: "parsing" });
        },
      });
      const fileHash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      setSourceBlob({ url: blob.url, pathname: blob.pathname, contentType: blob.contentType, size: nextFile.size, fileHash });
      setRules(await getAllRules());
      setProgress({ current: 1, total: 1, percent: 100, status: "done" });
      showToast(large ? "大文件已上传，请选择规则开始异步导入" : "文件已上传，请选择解析规则", "success");
    } catch (error) {
      console.error(error);
      showToast(error instanceof Error ? error.message : "文件上传失败，请检查文件格式", "error");
      setProgress({ current: 0, total: 0, percent: 0, status: "error" });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const createAsyncTask = useCallback(async (rule: ParseRule) => {
    if (!file || !sourceBlob) {
      showToast("原始文件尚未完成 Private Blob 上传", "error");
      return;
    }
    const response = await fetch("/api/import-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file_name: file.name,
        parse_rule_id: rule.id,
        source_blob_url: sourceBlob.url,
        source_blob_pathname: sourceBlob.pathname,
        file_hash: sourceBlob.fileHash,
        file_mime: sourceBlob.contentType,
        file_size: sourceBlob.size,
        total_rows_hint: 0,
      }),
    });
    const result = await response.json() as { task_id?: string; error?: string; upload_response_ms?: number };
    if (!response.ok || !result.task_id) throw new Error(result.error || "异步任务创建失败");
    showToast(`任务已创建${result.upload_response_ms ? `，接口耗时 ${result.upload_response_ms}ms` : ""}`, "success");
    router.push(`/import-tasks/${result.task_id}`);
  }, [file, router, showToast, sourceBlob]);

  const handleParseWithRule = useCallback(async (rule: ParseRule) => {
    setSelectedRule(rule);
    if (isLargeFile) {
      setLoading(true);
      setProgress({ current: 0, total: 0, percent: 100, status: "done" });
      try {
        await createAsyncTask(rule);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "异步任务创建失败", "error");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!parsedFile || !sourceBlob) {
      showToast("原始文件尚未完成 Private Blob 上传", "error");
      return;
    }
    setLoading(true);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      setProgress({ current: 0, total: parsedFile.rows.length, percent: 15, status: "parsing" });
      await tick();
      const startTime = performance.now();
      const orderRows = parseFile(parsedFile, rule);
      const duration = performance.now() - startTime;
      setProgress({ current: orderRows.length, total: orderRows.length, percent: 60, status: "parsing" });
      await tick();
      const validationErrors = validateOrders(orderRows);
      const consistencyErrors = checkReceiverConsistency(orderRows);
      setProgress({ current: orderRows.length, total: orderRows.length, percent: 85, status: "parsing" });
      const codes = Array.from(new Set(orderRows.map((row) => row.externalCode?.trim()).filter(Boolean) as string[]));
      const existingCodes = await getExistingExternalCodes(codes).catch(() => new Set<string>());
      const dupErrors = checkExternalCodeDuplicates(orderRows, existingCodes);
      const allErrors = [...validationErrors, ...consistencyErrors, ...dupErrors];
      setProgress({ current: orderRows.length, total: orderRows.length, percent: 100, status: "done" });
      sessionStorage.setItem("previewData", JSON.stringify({ rows: orderRows, errors: allErrors, fileName: parsedFile.fileName, ruleName: rule.name, ruleId: rule.id, sourceBlob, parseDuration: Math.round(duration) }));
      showToast(`解析完成：${orderRows.length} 条记录，${allErrors.length} 处错误`, allErrors.length ? "info" : "success");
      router.push("/preview");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "解析失败，请检查规则和文件", "error");
      setProgress({ current: 0, total: 0, percent: 0, status: "error" });
    } finally {
      setLoading(false);
    }
  }, [createAsyncTask, isLargeFile, parsedFile, router, showToast, sourceBlob]);

  const canChooseRule = Boolean(file && sourceBlob && progress.status === "done");

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-[#1d2129]"><Sparkles className="mr-2 inline-block h-7 w-7 text-[#0fc6c2]" />万能导入 V2</h1>
        <p className="mt-2 text-sm text-[#86909c]">智能多格式批量下单系统 —— 小文件可预览，大文件自动异步导入</p>
      </div>

      <div className="card mb-6">
        <div className="mb-4 flex items-center gap-2"><FileText className="h-5 w-5 text-[#0fc6c2]" /><h2 className="text-base font-semibold text-[#1d2129]">步骤一：上传文件</h2></div>
        <FileUploadZone onFileSelected={handleFileSelected} disabled={loading} />
        {file && progress.status === "done" && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-[#e8fafa] px-3 py-2 text-sm text-[#0b6e6e]"><FileText className="h-4 w-4" /><span>{file.name}</span><span className="text-[#86909c]">({isLargeFile ? "大文件，后台统计行数" : `${parsedFile?.rows.length || 0} 行数据`})</span></div>
        )}
        {isLargeFile && file && progress.status === "done" && <div className="mt-3 flex items-start gap-2 rounded-md border border-[#b5e8e8] bg-[#f2fffd] px-3 py-3 text-sm text-[#0b6e6e]"><Zap className="mt-0.5 h-4 w-4 flex-shrink-0" /><div><strong>已启用大文件异步模式</strong><p className="mt-1 text-xs text-[#4e5969]">不在浏览器全量解析和展示，上传后由后台复用规则引擎、批量校验并入库；提交后可在任务详情查看进度和错误。</p></div></div>}
        {progress.status === "parsing" && <div className="mt-3"><ProgressBar percent={progress.percent} label={isLargeFile ? "正在上传大文件..." : "正在读取文件..."} /></div>}
      </div>

      {canChooseRule && (
        <div className="card mb-6 animate-fade-in">
          <div className="mb-4 flex items-center gap-2"><Database className="h-5 w-5 text-[#0fc6c2]" /><h2 className="text-base font-semibold text-[#1d2129]">步骤二：选择解析规则</h2></div>
          {isLargeFile && <div className="mb-4 rounded-md bg-[#fff7e8] px-3 py-2 text-xs text-[#8a5700]">大文件请选择已确认保存的规则；选择后将直接创建异步任务，不进入浏览器预览。</div>}
          <RuleSelector rules={rules} selectedRule={selectedRule} parsedFile={parsedFile} onSelectRule={handleParseWithRule} loading={loading} allowCreateRule={!isLargeFile} actionLabel={isLargeFile ? "直接异步导入" : "使用此规则"} loadingLabel={isLargeFile ? "创建任务" : "解析中"} />
          {loading && !isLargeFile && <div className="mt-4"><ProgressBar percent={progress.percent} label={`正在解析... ${progress.current}/${progress.total}`} /></div>}
        </div>
      )}

      {!file && <div className="card"><div className="mb-3 flex items-center gap-2"><ArrowRight className="h-5 w-5 text-[#0fc6c2]" /><h2 className="text-base font-semibold text-[#1d2129]">快速开始</h2></div><div className="grid gap-3 text-sm text-[#4e5969]"><div className="flex items-start gap-3"><span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-xs font-bold text-[#0fc6c2]">1</span><span>上传 Excel 或 PDF 文件，系统会按文件大小选择预览或异步模式</span></div><div className="flex items-start gap-3"><span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-xs font-bold text-[#0fc6c2]">2</span><span>小文件可预览编辑；大文件选择已确认规则后直接创建后台任务</span></div><div className="flex items-start gap-3"><span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#e8fafa] text-xs font-bold text-[#0fc6c2]">3</span><span>在任务详情页查看处理进度、错误明细、Trace 和批量入库结果</span></div></div></div>}
    </div>
  );
}
