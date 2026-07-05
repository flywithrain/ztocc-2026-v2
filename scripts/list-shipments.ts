import { config } from "dotenv";
config({ path: ".env.local" });
import { Pool } from "@neondatabase/serverless";
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await p.query("SELECT id, external_code, store_name, submitted_at FROM shipments ORDER BY submitted_at DESC LIMIT 5");
  console.log(JSON.stringify(r.rows, null, 2));
  await p.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
