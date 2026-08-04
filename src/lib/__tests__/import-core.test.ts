import assert from "node:assert/strict";
import test from "node:test";
import { canClaimBatch, classifyRows, makeBatchRanges, resolveFinalStatus } from "../import-core";
import type { OrderRow } from "@/types";

const row = (rowIndex: number): OrderRow => ({ id: crypto.randomUUID(), rowIndex, externalCode: `ORDER_${rowIndex}`, storeName: "测试门店", receiverName: "", receiverPhone: "", receiverAddress: "", skuCode: `SKU_${rowIndex}`, skuName: "测试商品", skuQuantity: 1, skuSpec: "", remark: "" });

test("10,000 行按 1,000 行稳定分为 10 个幂等单元", () => { const ranges = makeBatchRanges(10000, 1000); assert.equal(ranges.length, 10); assert.deepEqual(ranges[9], { batchIndex: 9, unitId: "batch_0010", startRow: 9000, endRow: 10000 }); assert.equal(new Set(ranges.map((item) => item.unitId)).size, 10); });
test("部分行失败不会阻止成功行继续处理", () => { const rows = [row(0), row(1), row(2)]; const result = classifyRows(rows, [{ rowIndex: 1, field: "skuCode", message: "SKU 不存在" }]); assert.deepEqual(result.successfulRows.map((item) => item.rowIndex), [0, 2]); assert.deepEqual(result.failedRows.map((item) => item.rowIndex), [1]); });
test("最终状态聚合正确", () => { assert.equal(resolveFinalStatus(10, 0), "completed"); assert.equal(resolveFinalStatus(9, 1), "partial_success"); assert.equal(resolveFinalStatus(0, 10), "failed"); });
test("已完成批次不能重复认领，避免重复累计进度", () => { assert.equal(canClaimBatch("pending"), true); assert.equal(canClaimBatch("failed"), true); assert.equal(canClaimBatch("processing"), false); assert.equal(canClaimBatch("completed"), false); });
