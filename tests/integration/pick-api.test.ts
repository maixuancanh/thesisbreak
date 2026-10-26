import { describe, expect, it, vi, beforeEach } from "vitest";
const state = vi.hoisted(() => ({ authenticated: false, read: vi.fn() }));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const policy = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...policy,
    requireUser: async () => {
      if (!state.authenticated)
        throw new policy.AuthError(401, "UNAUTHENTICATED");
      return { id: "trusted-session-user" };
    },
  };
});
vi.mock("../../packages/db/src/picks", () => ({
  readPicks: state.read,
  createPick: vi.fn(),
  proposePick: vi.fn(),
  confirmPick: vi.fn(),
}));
import { GET, POST } from "../../apps/web/app/api/picks/route";
import { GET as detail } from "../../apps/web/app/api/picks/[pickId]/route";
describe("pick HTTP boundary (offline)", () => {
  beforeEach(() => {
    state.authenticated = false;
    state.read.mockReset();
    process.env.APP_URL = "https://example.test";
    process.env.DATABASE_URL = "postgres://offline";
  });
  it("requires authentication before reading or parsing mutations", async () => {
    expect(
      (await GET(new Request("https://example.test/api/picks"))).status,
    ).toBe(401);
    expect(
      (
        await POST(
          new Request("https://example.test/api/picks", {
            method: "POST",
            body: "not-json",
          }),
        )
      ).status,
    ).toBe(401);
    expect(state.read).not.toHaveBeenCalled();
  });
  it("checks mutation origin and rejects client-supplied ownership", async () => {
    state.authenticated = true;
    expect(
      (
        await POST(
          new Request("https://example.test/api/picks", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("https://example.test/api/picks", {
            method: "POST",
            headers: { origin: "https://example.test" },
            body: JSON.stringify({
              platform: "kalshi",
              nativeId: "TEST",
              outcome: "Yes",
              reason: "Reason",
              requestId: "request",
              userId: "foreign",
            }),
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("scopes details by trusted session user and hides foreign picks", async () => {
    state.authenticated = true;
    state.read.mockRejectedValue(new Error("NOT_FOUND"));
    const id = "ca86d67c-760c-43a9-8fb5-2c6eeb155f6e";
    const response = await detail(
      new Request(`https://example.test/api/picks/${id}`),
      { params: Promise.resolve({ pickId: id }) },
    );
    expect(response.status).toBe(404);
    expect(state.read).toHaveBeenCalledWith(
      expect.anything(),
      "trusted-session-user",
      id,
    );
  });
});
