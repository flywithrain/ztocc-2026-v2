import { del, get, head, put } from "@vercel/blob";
import { IMPORT_BLOB_PREFIXES } from "@/lib/blob-paths";
import type { OrderRow } from "@/types";

const SOURCE_PREFIX = IMPORT_BLOB_PREFIXES.source;
const MANIFEST_PREFIX = IMPORT_BLOB_PREFIXES.manifest;
const BATCH_PREFIX = IMPORT_BLOB_PREFIXES.batch;

export const IMPORT_ALLOWED_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
  "application/json",
] as const;

export type ImportEditManifest = {
  schema_version: 1;
  mode?: "patch" | "replace";
  deleted_row_indexes: number[];
  upserts: OrderRow[];
};

function requireBlobToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("缺少 BLOB_READ_WRITE_TOKEN，无法访问 Vercel Private Blob");
  }
}

export function getImportMaxFileSizeBytes() {
  return Math.max(1, Number(process.env.IMPORT_MAX_FILE_SIZE_MB || 50)) * 1024 * 1024;
}

export function assertImportBlobReference(url: string, pathname: string, kind: "source" | "manifest" | "batch") {
  const prefix = kind === "source" ? SOURCE_PREFIX : kind === "manifest" ? MANIFEST_PREFIX : BATCH_PREFIX;
  if (!pathname.startsWith(prefix) || pathname.includes("..")) {
    throw new Error(`非法的 ${kind} Blob pathname`);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".blob.vercel-storage.com")) {
    throw new Error(`非法的 ${kind} Blob URL`);
  }
}

export async function verifyImportBlob(pathname: string, expectedMaxBytes?: number) {
  requireBlobToken();
  const metadata = await head(pathname);
  if (expectedMaxBytes && metadata.size > expectedMaxBytes) {
    throw new Error(`Blob 超过允许大小：${metadata.size} bytes`);
  }
  return metadata;
}

export async function readPrivateBlobBuffer(urlOrPathname: string) {
  requireBlobToken();
  const result = await get(urlOrPathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) throw new Error("Private Blob 不存在或不可读取");
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

export async function readPrivateBlobJson<T>(urlOrPathname: string): Promise<T> {
  const buffer = await readPrivateBlobBuffer(urlOrPathname);
  return JSON.parse(buffer.toString("utf8")) as T;
}

export async function writeBatchPayload(taskId: string, unitId: string, rows: OrderRow[]) {
  requireBlobToken();
  return put(`${BATCH_PREFIX}${taskId}/${unitId}.json`, JSON.stringify({ schema_version: 1, rows }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

export function collectSafeImportBlobPaths(paths: Array<string | null | undefined>) {
  return [...new Set(paths.filter((path): path is string => Boolean(path)).filter((path) =>
    !path.includes("..") &&
    (path.startsWith(SOURCE_PREFIX) || path.startsWith(MANIFEST_PREFIX) || path.startsWith(BATCH_PREFIX))
  ))];
}

export async function deleteImportBlobs(paths: Array<string | null | undefined>) {
  requireBlobToken();
  const safe = collectSafeImportBlobPaths(paths);
  if (safe.length) await del(safe);
  return safe.length;
}
