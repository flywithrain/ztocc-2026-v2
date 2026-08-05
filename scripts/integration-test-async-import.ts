import { config } from "dotenv";
import assert from "node:assert/strict";

config({ path: ".env.local", quiet: true });

async function main() {
  if (process.env.RUN_NEON_INTEGRATION_TEST !== "true") {
    throw new Error("为避免误写真实数据库，请显式设置 RUN_NEON_INTEGRATION_TEST=true");
  }

  const [{ sql }, service] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/import-service"),
  ]);
  const ruleRows = await sql`select id, config from parse_rules order by updated_at desc nulls last limit 1`;
  assert.ok(ruleRows.length, "至少需要一条解析规则");
  const parseRuleId = String(ruleRows[0].id);
  const rule = { id: parseRuleId, ...(ruleRows[0].config as object) } as never;
  const suffix = crypto.randomUUID().slice(0, 8);
  const rows = [
    {
      id: crypto.randomUUID(), rowIndex: 0, externalCode: `IT-${suffix}-A`, storeName: "集成测试门店",
      receiverName: "测试用户", receiverPhone: "13800000000", receiverAddress: "广东省深圳市南山区集成测试路 1 号",
      skuCode: "SKU_00001", skuName: "压测商品 1", skuQuantity: 1, skuSpec: "1 盒", remark: "集成测试",
    },
    {
      id: crypto.randomUUID(), rowIndex: 1, externalCode: `IT-${suffix}-B`, storeName: "集成测试门店",
      receiverName: "测试用户", receiverPhone: "13800000001", receiverAddress: "广东省深圳市南山区集成测试路 2 号",
      skuCode: `INVALID_${suffix}`, skuName: "非法 SKU", skuQuantity: 1, skuSpec: "1 盒", remark: "集成测试错误行",
    },
  ];

  const created = await service.createImportTask({ fileName: `integration-${suffix}.xlsx`, parseRuleId, rule, rows });
  try {
    const [atomic] = await sql`select
      (select count(*)::int from import_task_batches where task_id = ${created.task_id}) batches,
      (select count(*)::int from event_outbox where aggregate_id = ${created.task_id}) outbox,
      (select count(*)::int from trace_events where task_id = ${created.task_id} and event_name = 'ImportTaskCreated') created_trace`;
    assert.deepEqual(atomic, { batches: 1, outbox: 2, created_trace: 1 }, "任务、批次、Outbox、Trace 必须完整创建");

    const first = await service.processImportBatch(created.task_id, "batch_0001", {
      messageId: `integration-${suffix}`,
      deliveryAttempt: 1,
    });
    await service.finalizeTask(created.task_id);
    const firstTask = await service.getImportTask(created.task_id);
    assert.equal(first.idempotent, false);
    assert.equal(firstTask?.status, "partial_success");
    assert.equal(firstTask?.processed_rows, 2);
    assert.equal(firstTask?.success_rows, 1);
    assert.equal(firstTask?.failed_rows, 1);

    const beforeRetry = await sql`select
      (select count(*)::int from shipments where batch_id = ${created.task_id}) shipments,
      (select count(*)::int from import_task_errors where task_id = ${created.task_id}) errors`;
    const second = await service.processImportBatch(created.task_id, "batch_0001", {
      messageId: `integration-${suffix}-retry`,
      deliveryAttempt: 2,
    });
    const afterRetry = await sql`select
      (select count(*)::int from shipments where batch_id = ${created.task_id}) shipments,
      (select count(*)::int from import_task_errors where task_id = ${created.task_id}) errors`;
    assert.equal(second.idempotent, true, "完成任务再次消费不应认领批次");
    assert.deepEqual(afterRetry, beforeRetry, "重复消费不得重复写入运单或错误");

    await sql`update import_task_batches set status = 'processing', locked_at = now() - interval '10 minutes' where task_id = ${created.task_id}`;
    const recovered = await service.recoverStalledBatches();
    assert.ok(recovered.length >= 1, "卡死批次应能恢复为 failed");

    const [signals] = await sql`select
      (select count(*)::int from import_task_errors where task_id = ${created.task_id} and row_number = 2 and error_code = 'E001') row_error,
      (select count(*)::int from trace_events where task_id = ${created.task_id} and event_name in ('ImportBatchStarted','ImportBatchSucceeded','ImportTaskPartialSuccess')) trace_events,
      (select count(*)::int from batch_performance_log where task_id = ${created.task_id}) performance_logs,
      (select max(delivery_attempt)::int from import_task_batches where task_id = ${created.task_id}) delivery_attempt`;
    assert.equal(signals.row_error, 1);
    assert.ok(signals.trace_events >= 3);
    assert.equal(signals.performance_logs, 1);
    assert.equal(signals.delivery_attempt, 1, "幂等拒绝的重复投递不得覆盖已处理批次的交付元数据");

    console.log(JSON.stringify({
      ok: true,
      scope: "Neon database consumer core; QStash/Blob contracts are covered by qstash-blob.test.ts",
      task_id: created.task_id,
      assertions: 15,
      signals,
    }, null, 2));
  } finally {
    await sql.transaction([
      sql`delete from orders where shipment_id in (select id from shipments where batch_id = ${created.task_id})`,
      sql`delete from shipments where batch_id = ${created.task_id}`,
      sql`delete from event_outbox where aggregate_id = ${created.task_id}`,
      sql`delete from import_tasks where id = ${created.task_id}`,
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
