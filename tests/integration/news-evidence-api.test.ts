import { it, expect, vi, afterEach } from "vitest";
const state = vi.hoisted(() => ({ authenticated: false }));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const p = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...p,
    requireUser: async () => {
      if (!state.authenticated) throw new p.AuthError(401, "UNAUTHENTICATED");
      return { id: "u" };
    },
  };
});
import { independentGet } from "../../apps/web/lib/server/independent-service";
afterEach(() => {
  state.authenticated = false;
});
it("rejects unauthenticated source requests before network reads", async () => {
  expect(
    (
      await independentGet(
        new Request(
          "http://localhost:3013/api/evidence?platform=kalshi&id=TEST",
        ),
      )
    ).status,
  ).toBe(401);
});
it("rejects arbitrary source URLs and malformed identities", async () => {
  state.authenticated = true;
  expect(
    (
      await independentGet(
        new Request(
          "http://localhost:3013/api/evidence?platform=kalshi&id=TEST&url=https://private.internal",
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await independentGet(
        new Request(
          "http://localhost:3013/api/evidence?platform=kalshi&id=https://private.internal",
        ),
      )
    ).status,
  ).toBe(400);
});
