import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ALL_ROLES } from "@/server/db/schema";
import { createEventSubscription, type EventSubscription } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let facilityId: string;
  try {
    const context = await requireApiFacility(ALL_ROLES);
    facilityId = context.facilityId;
  } catch (error) {
    return apiErrorResponse(error);
  }

  const encoder = new TextEncoder();
  let subscription: EventSubscription | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  function cleanup(closeStream = false) {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    void subscription?.close();
    subscription = null;
    if (closeStream) {
      try {
        controllerRef?.close();
      } catch {
        // Stream may already be closed by the client.
      }
    }
    controllerRef = null;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
        }
      };

      write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ facilityId })}\n\n`);

      subscription = createEventSubscription(
        (event) => {
          if (event.facilityId !== facilityId) return;
          const eventName = event.type.replace(/[^a-z0-9_]/gi, "_");
          write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        (error) => {
          write(`event: stream_error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
        },
      );

      try {
        await subscription.listen();
      } catch (error) {
        write(
          `event: stream_error\ndata: ${JSON.stringify({
            message: error instanceof Error ? error.message : "Event stream unavailable",
          })}\n\n`,
        );
        cleanup(true);
        return;
      }

      heartbeat = setInterval(() => write(`: keep-alive\n\n`), 15_000);
      request.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export function OPTIONS() {
  return NextResponse.json({ ok: true });
}
