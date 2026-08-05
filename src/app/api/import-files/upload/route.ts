import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { IMPORT_ALLOWED_CONTENT_TYPES, getImportMaxFileSizeBytes } from "@/lib/blob-storage";

export const runtime = "nodejs";

function isAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  const expected = process.env.APP_BASE_URL?.replace(/\/$/, "");
  return !expected || origin === expected;
}

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "服务端未配置 Vercel Blob" }, { status: 503 });
  }

  try {
    const body = await request.json() as HandleUploadBody;
    // 只限制浏览器申请 token 的请求；upload-completed 是 Vercel Blob 官方回调，交由 SDK 验证。
    if (body.type === "blob.generate-client-token" && !isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Blob 上传请求来源不受信任" }, { status: 403 });
    }
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("imports/source/") && !pathname.startsWith("imports/manifests/")) {
          throw new Error("上传 pathname 不在允许的导入目录内");
        }
        if (pathname.includes("..")) throw new Error("非法 pathname");
        return {
          allowedContentTypes: [...IMPORT_ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: getImportMaxFileSizeBytes(),
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 60,
          tokenPayload: JSON.stringify({ purpose: pathname.startsWith("imports/source/") ? "import-source" : "import-manifest" }),
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.info("Import Blob upload completed", { pathname: blob.pathname, contentType: blob.contentType });
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Blob 上传授权失败" }, { status: 400 });
  }
}
