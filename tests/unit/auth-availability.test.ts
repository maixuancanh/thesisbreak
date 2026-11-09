import { describe, it, expect } from "vitest";
import {
  trackAuthBackend,
  withAuthAvailability,
} from "../../apps/web/lib/server/auth-policy";
describe("NextAuth swallowed failures", () => {
  it("rejects the engine success response after a swallowed signOut event failure", async () => {
    await expect(
      withAuthAvailability(async (reportFailure) => {
        // Mirrors installed NextAuth: catches event error then builds a cookie-clearing redirect.
        try {
          await trackAuthBackend(async () => {
            throw new Error("database down");
          }, reportFailure);
        } catch {
          /* native event engine catches */
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/account",
            "Set-Cookie": "session=; Max-Age=0",
          },
        });
      }),
    ).rejects.toMatchObject({ status: 503, message: "AUTH_UNAVAILABLE" });
  });
  it("rejects a swallowed session lookup error instead of returning signed out", async () => {
    await expect(
      withAuthAvailability(async (reportFailure) => {
        try {
          await trackAuthBackend(async () => {
            throw new Error("database down");
          }, reportFailure);
        } catch {
          /* native session engine returns empty session */
        }
        return {};
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("keeps callback failures scoped to one concurrent request", async () => {
    const results = await Promise.allSettled([
      withAuthAvailability(async (reportFailure) => {
        reportFailure();
        return {};
      }),
      withAuthAvailability(async () => ({ user: { id: "active" } })),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]).toEqual({
      status: "fulfilled",
      value: { user: { id: "active" } },
    });
  });
});
