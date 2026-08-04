import { NextRequest, NextResponse } from "next/server";
import { generateRule } from "@/lib/ai-client";
import type { RawRow } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: NextRequest) {
  try {
    const { rows, fileType, fileName } = await request.json() as {
      rows?: RawRow[];
      fileType?: string;
      fileName?: string;
    };

    if (!Array.isArray(rows) || !fileType || !fileName) {
      return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
    }
    if (rows.length > 500) {
      return NextResponse.json({ error: "AI 分析样本最多支持 500 行" }, { status: 413 });
    }

    return NextResponse.json(await generateRule(rows, fileType, fileName));
  } catch (error) {
    console.error("AI 规则生成失败", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI 规则生成失败" },
      { status: 500 }
    );
  }
}
