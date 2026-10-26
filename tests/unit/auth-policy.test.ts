import { describe, it, expect, vi } from "vitest";
import {
  authConfigured,
  assertMutationOrigin,
  resolveIdentity,
} from "../../apps/web/lib/server/auth-policy";
describe("authentication policy", () => {
  it("fails closed without explicit configuration, even with dev login flags", () => {
    expect(
      authConfigured({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" }),
    ).toBe(false);
    expect(
      authConfigured({
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
        AUTH_SECRET: "x".repeat(32),
        APP_URL: "https://app.example",
        DATABASE_URL: "postgres://db",
      }),
    ).toBe(true);
  });
  it("requires an exact configured origin", () => {
    expect(() =>
      assertMutationOrigin(
        new Request("https://app.example/api", {
          headers: { origin: "https://evil.example" },
        }),
        "https://app.example",
      ),
    ).toThrow("ORIGIN_FORBIDDEN");
    expect(() =>
      assertMutationOrigin(
        new Request("https://app.example/api"),
        "https://app.example",
      ),
    ).toThrow();
  });
  it("does not trust missing or malformed server claims or client userId", async () => {
    const lookup = vi.fn();
    expect(await resolveIdentity(null, lookup)).toBeNull();
    expect(await resolveIdentity({ sub: 12, sid: "s" }, lookup)).toBeNull();
    expect(
      await resolveIdentity({ userId: "attacker" } as never, lookup),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
  it("requires an active persisted identity and session", async () => {
    expect(
      await resolveIdentity(
        { sub: "internal", sid: "expired" },
        async () => null,
      ),
    ).toBeNull();
    expect(
      await resolveIdentity({ sub: "internal", sid: "valid" }, async (sub) => ({
        id: sub,
      })),
    ).toEqual({ id: "internal" });
  });
});
