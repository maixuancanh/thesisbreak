import { beforeEach, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({
  user: vi.fn(),
  db: vi.fn(),
  submit: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  withdraw: vi.fn(),
  after: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("next/server", () => ({ after: mock.after }));
vi.mock("../../apps/web/lib/server/auth", async () => ({
  ...(await import("../../apps/web/lib/server/auth-policy")),
  requireUser: mock.user,
}));
vi.mock("../../apps/web/lib/server/chat-session-service", () => ({
  sessionDb: mock.db,
}));
vi.mock("../../packages/db/src/claim-challenges", () => ({
  submitClaimChallenge: mock.submit,
  readClaimChallenge: mock.read,
  withdrawClaimChallenge: mock.withdraw,
  listMessageClaimChallenges: mock.list,
}));
vi.mock("../../packages/integrations/src/claim-challenge-worker", () => ({
  createChallengeVerifier: vi.fn(),
  runOneClaimChallengeJob: vi.fn(),
}));
import { claimChallengeRequest } from "../../apps/web/lib/server/claim-challenge-service";
import { AuthError } from "../../apps/web/lib/server/auth";
const request = (method = "GET", body?: unknown) =>
  new Request("https://app.test/api/claim-challenges?messageId=run", {
    method,
    headers: { origin: "https://app.test", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", "https://app.test");
  vi.stubEnv("THESISBREAK_ACCOUNTABILITY_ENABLED", "true");
  mock.user.mockResolvedValue({ id: "owner" });
  mock.db.mockReturnValue("pool");
});
it("returns compatible legacy feedback without touching unavailable tables when disabled", async () => {
  vi.stubEnv("THESISBREAK_ACCOUNTABILITY_ENABLED", "false");
  const response = await claimChallengeRequest(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ claims: [], challenges: [] });
  expect(mock.db).not.toHaveBeenCalled();
  expect((await claimChallengeRequest(request("POST", {}))).status).toBe(503);
  expect(
    (await claimChallengeRequest(request("PATCH", {}), "challenge")).status,
  ).toBe(503);
  expect(mock.submit).not.toHaveBeenCalled();
});
it("authenticates owner and rejects foreign origins before persistence", async () => {
  mock.user.mockRejectedValueOnce(new AuthError(401, "UNAUTHENTICATED"));
  expect((await claimChallengeRequest(request())).status).toBe(401);
  expect(
    (
      await claimChallengeRequest(
        new Request("https://app.test/api/claim-challenges", {
          method: "POST",
          headers: { origin: "https://evil.test" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  expect(mock.db).not.toHaveBeenCalled();
});
it("binds listing and challenge reads to current owner", async () => {
  mock.list.mockResolvedValue({ claims: [], challenges: [] });
  expect((await claimChallengeRequest(request())).status).toBe(200);
  expect(mock.list).toHaveBeenCalledWith("pool", "owner", "run");
  mock.read.mockRejectedValue(new Error("NOT_FOUND"));
  expect((await claimChallengeRequest(request(), "other")).status).toBe(404);
});
it("reports stale withdrawals as conflicts", async () => {
  mock.withdraw.mockRejectedValue(new Error("REVISION_CONFLICT"));
  expect(
    (
      await claimChallengeRequest(
        request("PATCH", { action: "withdraw", expectedRevision: 1 }),
        "challenge",
      )
    ).status,
  ).toBe(409);
  expect(mock.withdraw).toHaveBeenCalledWith("pool", "owner", "challenge", {
    action: "withdraw",
    expectedRevision: 1,
  });
});
