import type { OrderRow, ValidationError } from "@/types";

export function makeBatchRanges(totalRows: number, batchSize: number) {
  if (totalRows < 0 || batchSize <= 0) throw new Error("批量参数非法");
  return Array.from({ length: Math.ceil(totalRows / batchSize) }, (_, batchIndex) => ({ batchIndex, unitId: `batch_${String(batchIndex + 1).padStart(4, "0")}`, startRow: batchIndex * batchSize, endRow: Math.min((batchIndex + 1) * batchSize, totalRows) }));
}

export function classifyRows(rows: OrderRow[], errors: ValidationError[]) {
  const failedIndexes = new Set(errors.map((error) => error.rowIndex));
  return { successfulRows: rows.filter((row) => !failedIndexes.has(row.rowIndex)), failedRows: rows.filter((row) => failedIndexes.has(row.rowIndex)) };
}

export function resolveFinalStatus(successRows: number, failedRows: number) {
  if (successRows === 0 && failedRows > 0) return "failed" as const;
  if (failedRows > 0) return "partial_success" as const;
  return "completed" as const;
}

export function canClaimBatch(status: string) {
  return status === "pending" || status === "failed";
}
