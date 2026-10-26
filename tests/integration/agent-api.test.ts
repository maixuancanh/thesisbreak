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
      return { id: "owned" };
    },
  };
});
import { POST } from "../../apps/web/app/api/agent/messages/route";
import { GET } from "../../apps/web/app/api/agent/history/route";
describe("agent HTTP authorization (offline)", () => {
  beforeEach(() => {
    state.authenticated = false;
    vi.stubEnv("APP_URL", "https://example.test");
    vi.stubEnv("LLM_BASE_URL", "https://provider.test/v1");
    vi.stubEnv("LLM_API_KEY", "offline-fixture");
    vi.stubEnv("LLM_MODEL", "fixture");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("requires auth before history and send body parsing", async () => {
    expect(
      (
        await POST(
          new Request("https://example.test/api/agent/messages", {
            method: "POST",
            body: "invalid",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await GET(
          new Request(
            "https://example.test/api/agent/history?platform=kalshi&id=TEST",
          ),
        )
      ).status,
    ).toBe(401);
  });
  it("requires same-origin mutations and rejects client context without calling a provider", async () => {
    state.authenticated = true;
    expect(
      (
        await POST(
          new Request("https://example.test/api/agent/messages", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("https://example.test/api/agent/messages", {
            method: "POST",
            headers: { origin: "https://example.test" },
            body: JSON.stringify({
              platform: "kalshi",
              nativeId: "TEST",
              provider: "public",
              message: "hello",
              requestId: "dbf74027-3a1b-4649-b9cd-25fdc02f5a02",
              userId: "foreign",
            }),
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("caps actual body bytes", async () => {
    state.authenticated = true;
    expect(
      (
        await POST(
          new Request("https://example.test/api/agent/messages", {
            method: "POST",
            headers: { origin: "https://example.test" },
            body: "a".repeat(17000),
          }),
        )
      ).status,
    ).toBe(413);
  });
});
