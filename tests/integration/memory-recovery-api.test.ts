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
import { recoveryOperation } from "../../apps/web/lib/server/recovery-service";
describe("recovery HTTP boundaries", () => {
  beforeEach(() => {
    state.authenticated = false;
    vi.stubEnv("APP_URL", "https://app.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (body: string, origin = "https://app.test") =>
    new Request("https://app.test/api/memory/recovery", {
      method: "POST",
      headers: { origin },
      body,
    });
  it("authenticates GET before inventory access", async () => {
    expect(
      (
        await recoveryOperation(
          new Request("https://app.test/api/memory/recovery"),
        )
      ).status,
    ).toBe(401);
  });
  it("requires owner authentication before parsing", async () => {
    expect((await recoveryOperation(request("bad"), true)).status).toBe(401);
  });
  it("requires same origin", async () => {
    state.authenticated = true;
    expect(
      (
        await recoveryOperation(
          request('{"confirmed":true}', "https://evil.test"),
          true,
        )
      ).status,
    ).toBe(403);
  });
  it.each([
    '{"confirmed":false}',
    '{"confirmed":true,"userId":"other"}',
    "{}",
    "invalid",
  ])("rejects unconfirmed or spoofed body %s", async (body) => {
    state.authenticated = true;
    expect((await recoveryOperation(request(body), true)).status).toBe(400);
  });
  it("bounds streaming body bytes", async () => {
    state.authenticated = true;
    expect(
      (await recoveryOperation(request("x".repeat(16385)), true)).status,
    ).toBe(413);
  });
});
