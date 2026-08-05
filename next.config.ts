import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  // 本地出现缓存锁时可用 NEXT_DIST_DIR 切换到独立构建目录；Vercel 默认仍使用 .next
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // 固定 V2 为 Turbopack 根目录，避免父目录遗留 lockfile 干扰工作区识别。
  turbopack: {
    root: projectRoot,
  },

  // Vercel Serverless 配置
  serverExternalPackages: ["pdfjs-dist"],

  // 仅 V2→V3 对外 API 开放可配置跨域；站内 API 保持同源。
  async headers() {
    const allowedOrigin = process.env.CORS_ALLOWED_ORIGIN || "http://localhost:3100";
    return [
      {
        source: "/api/v1/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: allowedOrigin },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, X-API-Key, X-Request-ID, Idempotency-Key" },
          { key: "Vary", value: "Origin" },
        ],
      },
    ];
  },

  // 仅控制 Server Actions；Route Handler 仍受 Vercel Function 4.5 MB 请求体限制。
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
