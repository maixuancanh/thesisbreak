import { describe, it, expect, vi, afterEach } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn() }));
vi.mock("../../apps/web/lib/server/auth", () => ({
  requireUser: mocks.user,
  AuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("../../apps/web/lib/server/tatum-service", () => ({
  readTatumOperation: mocks.read,
}));
import { GET } from "../../apps/web/app/api/markets/tatum-research/route";
import { AuthError } from "../../apps/web/lib/server/auth";
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
describe("authenticated Tatum read route", () => {
  it("rejects unauthenticated reads before service/network", async () => {
    mocks.user.mockRejectedValueOnce(new AuthError(401, "UNAUTHENTICATED"));
    const response = await GET(
      new Request(
        "https://app.test/api/markets/tatum-research?operation=events",
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects duplicate parameters", async () => {
    mocks.user.mockResolvedValueOnce({ id: "u" });
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    const response = await GET(
      new Request(
        "https://app.test/api/markets/tatum-research?operation=events&operation=quote",
      ),
    );
    expect(response.status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("returns an authenticated read without public HTTP caching", async () => {
    mocks.user.mockResolvedValueOnce({ id: "u" });
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    mocks.read.mockResolvedValueOnce({
      data: [],
      fetchedAt: "2026-10-27T00:00:00Z",
    });
    const response = await GET(
      new Request(
        "https://app.test/api/markets/tatum-research?operation=events&platform=polymarket",
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
