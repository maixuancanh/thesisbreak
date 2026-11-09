import { afterEach, expect, it, vi } from "vitest";
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
import { sourceOperation } from "../../apps/web/lib/server/source-service";
afterEach(() => {
  state.signedIn = false;
  vi.unstubAllEnvs();
});
it("source records require sign-in, origin, explicit consent and server-resolved grading fields", async () => {
  const request = (body: unknown, origin = "https://app.test") =>
    new Request("https://app.test/api/sources", {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await sourceOperation(request({}))).status).toBe(401);
  state.signedIn = true;
  vi.stubEnv("APP_URL", "https://app.test");
  expect(
    (await sourceOperation(request({}, "https://foreign.test"))).status,
  ).toBe(403);
  expect(
    (
      await sourceOperation(
        request({
          kind: "market_baseline",
          platform: "kalshi",
          nativeId: "KXTEST",
          confirmed: true,
          memoryConsent: false,
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await sourceOperation(
        request({
          kind: "market_baseline",
          platform: "kalshi",
          nativeId: "KXTEST",
          confirmed: true,
          memoryConsent: true,
          performance: { matched: 100 },
          resolution: { outcome: "Yes" },
        }),
      )
    ).status,
  ).toBe(400);
});
