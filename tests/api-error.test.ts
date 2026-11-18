import { afterEach, describe, expect, it, vi } from "vitest";

import { apiErrorResponse } from "../src/server/auth/api-error";
import { ForbiddenError, UnauthorizedError } from "../src/server/auth/rbac";

describe("API error responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a readable permission message instead of a bare Forbidden string", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = apiErrorResponse(new ForbiddenError());
    const body = (await response.json()) as { error: string; detail: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("Forbidden");
    expect(body.detail).toContain("do not have permission");
  });

  it("keeps unauthorized and forbidden responses distinct", async () => {
    const response = apiErrorResponse(new UnauthorizedError());
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });
});
