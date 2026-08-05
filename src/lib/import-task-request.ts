import type { BlobImportTaskInput } from "@/lib/import-types";

type ImportTaskRequestBody = {
  file_name?: string;
  parse_rule_id?: string;
  source_blob_url?: string;
  source_blob_pathname?: string;
  edit_manifest_blob_url?: string;
  edit_manifest_blob_pathname?: string;
  file_hash?: string;
  file_mime?: string;
  file_size?: number;
  total_rows_hint?: number;
  rows?: unknown;
};

export class ImportTaskRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ImportTaskRequestError";
  }
}

export function parseBlobImportTaskRequest(body: ImportTaskRequestBody): BlobImportTaskInput {
  if (body.rows !== undefined) {
    throw new ImportTaskRequestError("禁止向任务接口提交完整 rows；请使用 Private Blob 引用", 400);
  }
  if (!body.file_name || !body.parse_rule_id || !body.source_blob_url || !body.source_blob_pathname ||
    !body.file_hash || typeof body.file_size !== "number") {
    throw new ImportTaskRequestError("缺少文件、规则、SHA-256 或 Private Blob 引用", 400);
  }
  if (body.file_name.length > 500 || body.file_size <= 0 || body.file_size > 50 * 1024 * 1024) {
    throw new ImportTaskRequestError("文件名或文件大小不符合限制", 400);
  }
  return {
    fileName: body.file_name,
    parseRuleId: body.parse_rule_id,
    sourceBlobUrl: body.source_blob_url,
    sourceBlobPathname: body.source_blob_pathname,
    editManifestBlobUrl: body.edit_manifest_blob_url,
    editManifestBlobPathname: body.edit_manifest_blob_pathname,
    fileHash: body.file_hash,
    fileMime: body.file_mime,
    fileSize: body.file_size,
    totalRowsHint: body.total_rows_hint,
  };
}
