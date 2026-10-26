import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const state = vi.hoisted(() => ({ signedIn: false }));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const p = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...p,
    requireUser: async () => {
      if (!state.signedIn) throw new p.AuthError(401, "UNAUTHENTICATED");
      return { id: "owner" };
    },
  };
});
import { monitorOperation } from "../../apps/web/lib/server/monitor-service";
describe("monitor HTTP boundaries", () => {
  beforeEach(() => {
    state.signedIn = false;
    vi.stubEnv("APP_URL", "https://app.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (body: string, origin = "https://app.test") =>
    new Request("https://app.test/api/monitors", {
      method: "POST",
      headers: { origin },
      body,
    });
  it("requires auth and explicit owned instructions", async () => {
    expect((await monitorOperation(request("invalid"), "create")).status).toBe(
      401,
    );
    state.signedIn = true;
    expect(
      (await monitorOperation(request("{}", "https://foreign.test"), "create"))
        .status,
    ).toBe(403);
    expect(
      (
        await monitorOperation(
          request(JSON.stringify({ userId: "other" })),
          "create",
        )
      ).status,
    ).toBe(400);
    expect(
      (await monitorOperation(request("x".repeat(17000)), "create")).status,
    ).toBe(413);
  });
});
