import { config } from "dotenv";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

config({ path: ".env.local" });

const SKU_COUNT = Number(process.env.SEED_SKU_COUNT || 20000);
const ORDER_COUNT = Number(process.env.SEED_ORDER_COUNT || 10000);
const OUTPUT = path.resolve(process.env.SEED_OUTPUT || "test-data/10000-orders-fixed.xlsx");

async function main() {
  const { db } = await import("../src/lib/db");
  const { skuMaster } = await import("../src/lib/db-schema");
  const { sql: neonSql } = await import("../src/lib/db");
  const { sql: drizzleSql } = await import("drizzle-orm");
  const skuRows = Array.from({ length: SKU_COUNT }, (_, index) => ({ skuCode: `SKU_${String(index + 1).padStart(5, "0")}`, name: `压测商品 ${index + 1}`, spec: `${(index % 6) + 1} 盒`, unit: "件" }));
  if (process.env.SEED_SKIP_DB !== "true") {
    console.log(`清理并写入 ${SKU_COUNT} 条 SKU 主数据...`);
    await neonSql`delete from sku_master where sku_code like 'SKU_%'`;
    for (let i = 0; i < skuRows.length; i += 1000) await db.insert(skuMaster).values(skuRows.slice(i, i + 1000)).onConflictDoUpdate({ target: skuMaster.skuCode, set: { name: drizzleSql`excluded.name`, spec: drizzleSql`excluded.spec`, unit: drizzleSql`excluded.unit` } });
  } else {
    console.log("SEED_SKIP_DB=true：仅生成 Excel，不修改数据库。");
  }

  const orderRows = Array.from({ length: ORDER_COUNT }, (_, index) => {
    const orderIndex = Math.floor(index / 2);
    const valid = index % 97 !== 0;
    const skuIndex = (index * 37) % SKU_COUNT;
    return {
      外部编码: `LOAD_${String(orderIndex + 1).padStart(6, "0")}`,
      收货门店: `大促门店 ${(orderIndex % 120) + 1}`,
      收件人姓名: `测试收件人${orderIndex + 1}`,
      收件人电话: `138${String(orderIndex % 100000000).padStart(8, "0")}`,
      收件人地址: `广东省深圳市南山区压测路 ${orderIndex + 1} 号`,
      SKU编码: valid ? `SKU_${String(skuIndex + 1).padStart(5, "0")}` : `INVALID_${String(index).padStart(5, "0")}`,
      SKU名称: valid ? `压测商品 ${skuIndex + 1}` : "非法 SKU 样本",
      数量: (index % 8) + 1,
      SKU规格: `${(index % 6) + 1} 盒`,
      备注: valid ? "压测数据" : "故意插入非法 SKU，用于验证 E001 错误定位",
    };
  });
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(orderRows), "出库单");
  XLSX.writeFile(workbook, OUTPUT);
  console.log(`✅ 完成：${SKU_COUNT} 条 SKU，${ORDER_COUNT} 行 Excel：${OUTPUT}`);
  console.log("重复执行策略：仅删除 SKU_ 前缀压测主数据，Excel 文件覆盖写入；业务任务与日志需按 task_id 定向清理。");
}

main().catch((error) => { console.error(error); process.exit(1); });
