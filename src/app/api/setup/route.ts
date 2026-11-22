import { NextResponse } from "next/server";

import { bootstrapFirstRun, bootstrapFirstRunSchema, getFirstRunStatus } from "@/server/commands/bootstrap";

export async function GET() {
  try {
    const status = await getFirstRunStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read setup status" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const status = await getFirstRunStatus();
    if (!status.required) {
      return NextResponse.json({ error: "Initial setup has already been completed" }, { status: 409 });
    }

    const body = await request.json();
    const parsed = bootstrapFirstRunSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid setup data", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await bootstrapFirstRun(parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Setup failed" },
      { status: 400 },
    );
  }
}
