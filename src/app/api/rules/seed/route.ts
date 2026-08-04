import { NextResponse } from "next/server";
import { seedDemoRules } from "@/lib/seed-rules";

// POST /api/rules/seed — 仅本地/预览环境允许通过页面初始化；生产请运行 npm run db:seed。
export async function POST() {
  if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { success: false, error: "生产环境禁止通过公开接口初始化规则，请使用部署前脚本" },
      { status: 403 }
    );
  }

  try {
    const count = await seedDemoRules();
    return NextResponse.json({ success: true, count });
  } catch (error) {
    console.error("Seed failed:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
