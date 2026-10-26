import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const state = vi.hoisted(() => ({ authenticated: false }));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const policy = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...policy,
    requireUser: async () => {
      if (!state.authenticated)
        throw new policy.AuthError(401, "UNAUTHENTICATED");
      return { id: "owner" };
    },
  };
});
import { lessonOperation } from "../../apps/web/lib/server/lesson-service";
describe("lesson HTTP boundaries", () => {
  beforeEach(() => {
    state.authenticated = false;
    vi.stubEnv("APP_URL", "https://app.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("authenticates before parsing and never accepts browser ownership", async () => {
    const request = (body: string, origin = "https://app.test") =>
      new Request("https://app.test/api/lessons", {
        method: "POST",
        headers: { origin },
        body,
      });
    expect((await lessonOperation(request("invalid"), "create")).status).toBe(
      401,
    );
    state.authenticated = true;
    expect(
      (await lessonOperation(request("{}", "https://evil.test"), "create"))
        .status,
    ).toBe(403);
    expect(
      (
        await lessonOperation(
          request(JSON.stringify({ userId: "other" })),
          "create",
        )
      ).status,
    ).toBe(400);
    expect(
      (await lessonOperation(request("x".repeat(17000)), "create")).status,
    ).toBe(413);
  });
});
