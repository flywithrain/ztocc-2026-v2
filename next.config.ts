import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 本地出现缓存锁时可用 NEXT_DIST_DIR 切换到独立构建目录；Vercel 默认仍使用 .next
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // Vercel Serverless 配置
  serverExternalPackages: ["pdfjs-dist"],

  // 允许跨域访问API
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, X-API-Key, X-Request-ID, Idempotency-Key" },
        ],
      },
    ];
  },

  // 文件上传大小限制
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
