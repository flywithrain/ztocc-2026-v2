import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { traceEvents } from "@/lib/db-schema";

export async function GET(_request: Request, context: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await context.params;
  const events = await db.select().from(traceEvents).where(eq(traceEvents.traceId, traceId)).orderBy(asc(traceEvents.occurredAt));
  return NextResponse.json({ trace_id: traceId, events: events.map((event) => ({ id: event.id, task_id: event.taskId, unit_id: event.unitId, event_name: event.eventName, event_status: event.eventStatus, message: event.message, metadata: event.metadata, occurred_at: event.occurredAt })) });
}
