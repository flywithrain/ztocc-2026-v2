/**
 * V2 测试运单种子：插 3 条 shipments + 各自 SKU 明细，供 V3 验收用。
 * 这不是 V2 既有文件改动，仅新增脚本。运行：npx tsx scripts/seed-test-shipments.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "../src/lib/db-schema";
import { shipments, orders } from "../src/lib/db-schema";
import { sql } from "drizzle-orm";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool, schema });

  // 先清掉旧测试运单（按 external_code 前缀 V3TEST）
  await db.delete(orders).where(
    sql`shipment_id IN (SELECT id FROM shipments WHERE external_code LIKE 'V3TEST%')`
  );
  await db.delete(shipments).where(
    sql`external_code LIKE 'V3TEST%'`
  );

  const now = new Date();
  const defs = [
    {
      externalCode: "V3TEST-LOW",
      storeName: "尹三顺自助烤肉（银泰店）",
      receiverName: "王店长",
      receiverPhone: "13900001111",
      receiverAddress: "汉口解放大道688号银泰百货B1层",
      remark: "测试低金额运单",
      items: [
        { skuCode: "ZBWP0001", skuName: "茶语柠听紫苏风味糖浆", skuQuantity: "6", skuSpec: "750ml*6瓶/件" },
      ],
    },
    {
      externalCode: "V3TEST-HIGH",
      storeName: "黎明屯铁锅炖（海口龙湖天街店）",
      receiverName: "张锦峰",
      receiverPhone: "18533660999",
      receiverAddress: "海南省海口市龙华区金宇街道南海大道15号龙湖海口天街",
      remark: "测试高金额运单",
      items: [
        { skuCode: "ZBWP0030", skuName: "精品五花肉卷", skuQuantity: "10", skuSpec: "10kg/件" },
        { skuCode: "ZBWP0035", skuName: "雪花肥牛卷", skuQuantity: "8", skuSpec: "15kg/件" },
      ],
    },
    {
      externalCode: "V3TEST-HD",
      storeName: "黔寨寨贵州烙锅（鞍山首店）",
      receiverName: "荣丽",
      receiverPhone: "13130093946",
      receiverAddress: "辽宁省鞍山市铁东区建国大道700号万象汇",
      remark: "测试 high 严重度运单",
      items: [
        { skuCode: "ZBWP0025", skuName: "麻辣折耳根脆", skuQuantity: "12", skuSpec: "1.5kg*6包/件" },
      ],
    },
  ];

  for (const d of defs) {
    const batchId = crypto.randomUUID();
    const [s] = await db
      .insert(shipments)
      .values({
        externalCode: d.externalCode,
        storeName: d.storeName,
        receiverName: d.receiverName,
        receiverPhone: d.receiverPhone,
        receiverAddress: d.receiverAddress,
        remark: d.remark,
        skuCount: d.items.length,
        totalQuantity: String(d.items.reduce((a, e) => a + Number(e.skuQuantity), 0)),
        batchId,
        submittedAt: now,
      })
      .returning({ id: shipments.id, externalCode: shipments.externalCode });
    await db.insert(orders).values(
      d.items.map((it) => ({ shipmentId: s.id, ...it }))
    );
    console.log(`  插入运单 ${s.externalCode} (id=${s.id}) 含 ${d.items.length} 个 SKU`);
  }

  await pool.end();
  console.log("完成。");
}

main().catch((e) => { console.error(e); process.exit(1); });
