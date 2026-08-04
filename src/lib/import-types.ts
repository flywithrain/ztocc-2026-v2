import type { OrderRow, ParseRule } from "@/types";

export type ImportTaskStatus = "pending" | "processing" | "completed" | "partial_success" | "failed";
export type BatchStatus = "pending" | "processing" | "completed" | "failed";

export interface ImportTaskPayload {
  fileName: string;
  rule: ParseRule;
  rows: OrderRow[];
}

export interface ImportTaskSummary {
  task_id: string;
  trace_id: string;
  file_name: string;
  status: ImportTaskStatus;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  throughput: number;
  eta_seconds: number | null;
  degraded: boolean;
  degraded_reason: string | null;
  recent_errors: { error_code: string; error_reason: string; count: number }[];
}

export interface ImportEventEnvelope<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  schema_version: number;
  aggregate_id: string;
  trace_id: string;
  occurred_at: string;
  payload: TPayload;
}
