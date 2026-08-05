import { Receiver } from "@upstash/qstash";

function createReceiver() {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error("缺少 QStash signing keys");
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

export async function verifyQStashRequest(request: Request, rawBody: string) {
  const signature = request.headers.get("upstash-signature");
  if (!signature) return false;
  return createReceiver().verify({
    signature,
    body: rawBody,
    url: request.url,
    upstashRegion: request.headers.get("upstash-region") || undefined,
    clockTolerance: 5,
  });
}

export function getQStashDeliveryMetadata(request: Request) {
  const attemptValue =
    request.headers.get("upstash-retried") ||
    request.headers.get("upstash-retries") ||
    request.headers.get("upstash-delivery-attempt") ||
    "0";
  return {
    messageId: request.headers.get("upstash-message-id"),
    deliveryAttempt: Math.max(0, Number(attemptValue) || 0) + 1,
  };
}
