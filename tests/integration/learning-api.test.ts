import { randomUUID } from "node:crypto";
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
import { learningCandidateOperation } from "../../apps/web/lib/server/learning-service";
describe("candidate review HTTP boundary", () => {
  beforeEach(() => {
    state.authenticated = false;
    vi.stubEnv("APP_URL", "https://app.test");
    vi.stubEnv("DATABASE_URL", "postgres://local/test");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("authenticates, checks origin, rejects ownership injection and bounds bodies", async () => {
    const id = randomUUID();
    const req = (body: string, origin = "https://app.test") =>
      new Request("https://app.test/api/learning/candidates/" + id, {
        method: "POST",
        headers: { origin },
        body,
      });
    expect((await learningCandidateOperation(req("invalid"), id)).status).toBe(
      401,
    );
    state.authenticated = true;
    expect(
      (await learningCandidateOperation(req("{}", "https://foreign.test"), id))
        .status,
    ).toBe(403);
    expect(
      (
        await learningCandidateOperation(
          req(JSON.stringify({ userId: "foreign" })),
          id,
        )
      ).status,
    ).toBe(400);
    expect(
      (await learningCandidateOperation(req("x".repeat(17000)), id)).status,
    ).toBe(413);
  });
});
