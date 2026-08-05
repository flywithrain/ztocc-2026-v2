import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { assertImportBlobReference, collectSafeImportBlobPaths, getImportMaxFileSizeBytes } from "../blob-storage";
import { buildManifestBlobPath, buildSourceBlobPath, IMPORT_BLOB_PREFIXES } from "../blob-paths";
import { ImportTaskRequestError, parseBlobImportTaskRequest } from "../import-task-request";
import { buildQStashPublishRequest, isQStashConfigured } from "../qstash-publisher";
import { getQStashDeliveryMetadata, verifyQStashRequest } from "../qstash-receiver";
import type { ImportEventEnvelope } from "../import-types";

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function signQStashBody(body: string, url: string, key: string) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    iss: "Upstash",
    sub: url,
    body: createHash("sha256").update(body).digest("base64url"),
    iat: now,
    exp: now + 60,
  }));
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", key).update(content).digest("base64url")}`;
}

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  return Promise.resolve(run()).finally(() => {
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
}

const event: ImportEventEnvelope = {
  event_id: "11111111-1111-4111-8111-111111111111",
  event_type: "ImportBatchCreated",
  schema_version: 1,
  aggregate_id: "22222222-2222-4222-8222-222222222222",
  trace_id: "33333333-3333-4333-8333-333333333333",
  occurred_at: "2026-08-04T00:00:00.000Z",
  payload: { task_id: "22222222-2222-4222-8222-222222222222", unit_id: "batch_0001" },
};

test("Blob pathname 只允许导入隔离前缀并清理危险文件名", () => {
  const source = buildSourceBlobPath("../订单 明细(最终).xlsx");
  const manifest = buildManifestBlobPath();
  assert.ok(source.startsWith(IMPORT_BLOB_PREFIXES.source));
  assert.ok(!source.includes("订单"));
  assert.ok(!source.includes(".."));
  assert.ok(manifest.startsWith(IMPORT_BLOB_PREFIXES.manifest));
  assertImportBlobReference(
    "https://exam-store.public.blob.vercel-storage.com/imports/source/a/file.xlsx",
    "imports/source/a/file.xlsx",
    "source"
  );
  assert.throws(() => assertImportBlobReference(
    "https://evil.example.com/imports/source/a/file.xlsx",
    "imports/source/a/file.xlsx",
    "source"
  ), /非法的 source Blob URL/);
  assert.throws(() => assertImportBlobReference(
    "https://exam-store.public.blob.vercel-storage.com/imports/source/a/file.xlsx",
    "imports/source/../secret",
    "source"
  ), /非法的 source Blob pathname/);
});

test("Blob 清理只接受导入前缀、去重并拒绝路径穿越", () => {
  assert.deepEqual(collectSafeImportBlobPaths([
    "imports/source/a/file.xlsx",
    "imports/source/a/file.xlsx",
    "imports/manifests/a.json",
    "imports/batches/task/batch_0001.json",
    "imports/source/../secret",
    "other/personal-file.txt",
    null,
  ]), [
    "imports/source/a/file.xlsx",
    "imports/manifests/a.json",
    "imports/batches/task/batch_0001.json",
  ]);
});

test("Blob 文件大小上限从环境变量读取且至少为 1 MiB", async () => {
  await withEnv({ IMPORT_MAX_FILE_SIZE_MB: "7" }, () => {
    assert.equal(getImportMaxFileSizeBytes(), 7 * 1024 * 1024);
  });
  await withEnv({ IMPORT_MAX_FILE_SIZE_MB: "0" }, () => {
    assert.equal(getImportMaxFileSizeBytes(), 1024 * 1024);
  });
});

test("轻量任务合同拒绝完整 rows 并接受 Private Blob 引用", () => {
  assert.throws(() => parseBlobImportTaskRequest({ rows: [] }), (error) => {
    assert.ok(error instanceof ImportTaskRequestError);
    assert.equal(error.status, 400);
    assert.match(error.message, /禁止.*rows/);
    return true;
  });
  const parsed = parseBlobImportTaskRequest({
    file_name: "orders.xlsx",
    parse_rule_id: "rule-id",
    source_blob_url: "https://exam-store.public.blob.vercel-storage.com/imports/source/a/orders.xlsx",
    source_blob_pathname: "imports/source/a/orders.xlsx",
    file_hash: "a".repeat(64),
    file_size: 1024,
    total_rows_hint: 10000,
  });
  assert.equal(parsed.fileName, "orders.xlsx");
  assert.equal(parsed.totalRowsHint, 10000);
  assert.equal("rows" in parsed, false);
});

test("QStash Direct Publish 固定重试、失败回调、内容去重和 Flow Control", async () => {
  await withEnv({
    APP_BASE_URL: "https://v2.example.com/",
    QSTASH_TOKEN: "token",
    QSTASH_CURRENT_SIGNING_KEY: "current",
    QSTASH_NEXT_SIGNING_KEY: "next",
    QSTASH_RETRIES: "9",
    QSTASH_WORKER_PARALLELISM: "4",
    QSTASH_RETRY_DELAY: "1500",
    QSTASH_FLOW_CONTROL_KEY: "exam-import",
  }, () => {
    assert.equal(isQStashConfigured(), true);
    const request = buildQStashPublishRequest(event);
    assert.equal(request.url, "https://v2.example.com/api/internal/import-events");
    assert.equal(request.failureCallback, "https://v2.example.com/api/internal/import-events/failure");
    assert.equal(request.retries, 5, "重试次数必须钳制到 SDK 安全上限");
    assert.equal(request.retryDelay, "1500");
    assert.deepEqual(request.flowControl, { key: "exam-import", parallelism: 4 });
    assert.equal(request.contentBasedDeduplication, true);
    assert.deepEqual(request.label, ["v2-import", "ImportBatchCreated"]);
  });
});

test("QStash Receiver 接受 current/next key，拒绝伪造签名与篡改正文", async () => {
  await withEnv({
    QSTASH_CURRENT_SIGNING_KEY: "current-test-secret",
    QSTASH_NEXT_SIGNING_KEY: "next-test-secret",
  }, async () => {
    const url = "https://v2.example.com/api/internal/import-events";
    const body = JSON.stringify(event);
    for (const key of ["current-test-secret", "next-test-secret"]) {
      const request = new Request(url, { headers: { "upstash-signature": signQStashBody(body, url, key) } });
      assert.equal(await verifyQStashRequest(request, body), true);
    }
    await assert.rejects(
      verifyQStashRequest(new Request(url, { headers: { "upstash-signature": "forged" } }), body)
    );
    await assert.rejects(
      verifyQStashRequest(new Request(url, {
        headers: { "upstash-signature": signQStashBody(body, url, "current-test-secret") },
      }), `${body}tampered`)
    );
  });
});

test("QStash delivery metadata 记录 message ID 和至少一次投递序号", () => {
  const request = new Request("https://v2.example.com/api/internal/import-events", { headers: {
    "upstash-message-id": "msg_123",
    "upstash-retried": "2",
  } });
  assert.deepEqual(getQStashDeliveryMetadata(request), { messageId: "msg_123", deliveryAttempt: 3 });
});
