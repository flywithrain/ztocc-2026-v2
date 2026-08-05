import { Client } from "@upstash/qstash";
import type { ImportEventEnvelope } from "@/lib/import-types";

export type QStashPublishResult = {
  messageId: string;
  providerResponse: Record<string, unknown>;
};

function getBaseUrl() {
  const value = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (!value) throw new Error("缺少 APP_BASE_URL，无法生成 QStash 回调地址");
  return value;
}

export function isQStashConfigured() {
  return Boolean(
    process.env.QSTASH_TOKEN &&
    process.env.QSTASH_CURRENT_SIGNING_KEY &&
    process.env.QSTASH_NEXT_SIGNING_KEY &&
    process.env.APP_BASE_URL
  );
}

export function buildQStashPublishRequest(event: ImportEventEnvelope) {
  const baseUrl = getBaseUrl();
  const retries = Math.max(0, Math.min(5, Number(process.env.QSTASH_RETRIES || 3)));
  const parallelism = Math.max(1, Math.min(10, Number(process.env.QSTASH_WORKER_PARALLELISM || 4)));
  return {
    url: `${baseUrl}/api/internal/import-events`,
    body: event,
    retries,
    retryDelay: process.env.QSTASH_RETRY_DELAY || "1000",
    failureCallback: `${baseUrl}/api/internal/import-events/failure`,
    flowControl: {
      key: process.env.QSTASH_FLOW_CONTROL_KEY || "v2-import-worker",
      parallelism,
    },
    contentBasedDeduplication: true,
    label: ["v2-import", event.event_type],
  };
}

export async function publishImportEvent(event: ImportEventEnvelope): Promise<QStashPublishResult> {
  if (!process.env.QSTASH_TOKEN) throw new Error("缺少 QSTASH_TOKEN");
  const client = new Client({ token: process.env.QSTASH_TOKEN });
  const request = buildQStashPublishRequest(event);
  const response = await client.publishJSON(request);
  return {
    messageId: response.messageId,
    providerResponse: {
      message_id: response.messageId,
      destination: "import-events",
      retries: request.retries,
      parallelism: request.flowControl.parallelism,
    },
  };
}
