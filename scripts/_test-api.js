const dotenv = require("dotenv");
dotenv.config({ path: ".env.local" });

const u = process.env.DEEPSEEK_API_URL.trim();
const k = process.env.DEEPSEEK_API_KEY.trim().replace(/^["']|["']$/g, "");
const m = process.env.DEEPSEEK_MODEL.trim();

console.log("[TEST-1] url:", u.slice(0, 60), "model:", m, "keyLen:", k.length);

const t0 = Date.now();
fetch(u, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + k,
  },
  body: JSON.stringify({
    model: m,
    messages: [{ role: "user", content: "say hi" }],
    max_tokens: 5,
  }),
  signal: AbortSignal.timeout(15000),
})
  .then((r) => r.json())
  .then((d) => console.log("[TEST-2] OK in", Date.now() - t0, "ms |", JSON.stringify(d.choices?.[0]?.message).slice(0, 100)))
  .catch((e) => console.log("[TEST-2] FAIL in", Date.now() - t0, "ms |", e.name, e.message.slice(0, 200)));
