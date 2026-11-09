import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
const { session, query } = vi.hoisted(() => ({
  session: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/next-auth", () => ({
  getServerSession: session,
}));
vi.mock("pg", () => ({
  Pool: class {
    query = query;
  },
}));
import { authOptions, getAccountProfile } from "../../apps/web/lib/server/auth";
import { GET } from "../../apps/web/app/api/auth/status/route";

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://app.test");
  vi.stubEnv("AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("AUTH_GOOGLE_ID", "test");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test");
  vi.stubEnv("DATABASE_URL", "postgres://test");
  session.mockReset();
  query.mockReset();
});
describe("current account profile", () => {
  it("does not expose an identity for a revoked or absent session", async () => {
    session.mockResolvedValue({ expires: "later" });
    expect(await getAccountProfile()).toBeNull();
    expect(await (await GET()).json()).toMatchObject({
      authenticated: false,
      profile: null,
    });
  });
  it("returns only the validated session profile with private cache headers", async () => {
    session.mockResolvedValue({
      user: { id: "owner", name: "Alex", email: "alex@example.test" },
    });
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(await response.json()).toMatchObject({
      authenticated: true,
      profile: { name: "Alex", email: "alex@example.test" },
    });
  });
  it("keeps older sessions usable without inventing profile details", async () => {
    session.mockResolvedValue({ user: { id: "owner" } });
    expect(await getAccountProfile()).toEqual({
      id: "owner",
      name: null,
      email: null,
    });
  });
  it("does not turn a backend failure into signed-in profile data", async () => {
    session.mockRejectedValue(new Error("unavailable"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ authenticated: false });
  });
  it("keeps provider identity details in the signed-in token without retaining access tokens", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "owner" }] })
      .mockResolvedValueOnce({ rows: [] });
    const jwt = authOptions().callbacks!.jwt!;
    const result = await jwt({
      token: {},
      account: { provider: "google", providerAccountId: "google-user" },
      profile: { sub: "google-user", name: "Alex", email: "alex@example.test" },
    } as Parameters<typeof jwt>[0]);
    expect(result).toMatchObject({
      sub: "owner",
      name: "Alex",
      email: "alex@example.test",
    });
    expect(result).not.toHaveProperty("access_token");
    expect(result).not.toHaveProperty("refresh_token");
  });
});
