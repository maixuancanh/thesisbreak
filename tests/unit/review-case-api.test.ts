import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  authenticated: false,
  cases: vi.fn(),
  assessments: vi.fn(),
  followups: vi.fn(),
  set: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const p = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...p,
    requireUser: async () => {
      if (!state.authenticated) throw new p.AuthError(401, "UNAUTHENTICATED");
      return { id: "session-owner" };
    },
  };
});
vi.mock("../../packages/db/src/review-cases", () => ({
  listReviewCases: state.cases,
}));
vi.mock("../../packages/db/src/decision-evidence-assessments", () => ({
  readDecisionEvidenceAssessments: state.assessments,
}));
vi.mock("../../packages/db/src/review-followups", () => ({
  listReviewFollowups: state.followups,
  setReviewFollowup: state.set,
}));
import { GET } from "../../apps/web/app/api/review-cases/route";
import { PATCH } from "../../apps/web/app/api/review-followups/[followupId]/route";
describe("review case HTTP boundary", () => {
  beforeEach(() => {
    state.authenticated = false;
    for (const f of [
      state.cases,
      state.assessments,
      state.followups,
      state.set,
    ])
      f.mockReset();
    process.env.PICK_REASON_MONITORING_ENABLED = "true";
    process.env.THESISBREAK_ACCOUNTABILITY_ENABLED = "true";
    process.env.DATABASE_URL = "postgres://offline";
    process.env.APP_URL = "https://app.test";
    state.cases.mockResolvedValue({ items: [], nextCursor: null });
    state.followups.mockResolvedValue([]);
  });
  it("requires authentication and a feature flag before reading cases", async () => {
    expect(
      (await GET(new Request("https://app.test/api/review-cases"))).status,
    ).toBe(401);
    state.authenticated = true;
    expect(
      (await GET(new Request("https://app.test/api/review-cases"))).status,
    ).toBe(200);
    expect(state.cases.mock.calls[0]?.[1]).toBe("session-owner");
    delete process.env.THESISBREAK_ACCOUNTABILITY_ENABLED;
    expect(
      (await GET(new Request("https://app.test/api/review-cases"))).status,
    ).toBe(503);
  });
  it("rejects client owner fields and cross-origin reminder changes", async () => {
    state.authenticated = true;
    const update = (body: unknown, origin = "https://app.test") =>
      PATCH(
        new Request("https://app.test/api/review-followups/f", {
          method: "PATCH",
          headers: { origin },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ followupId: "f" }) },
      );
    expect(
      (
        await update(
          { caseRevision: 1, action: "stop" },
          "https://foreign.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (await update({ caseRevision: 1, action: "stop", ownerId: "other" }))
        .status,
    ).toBe(400);
    expect(state.set).not.toHaveBeenCalled();
    state.set.mockResolvedValue({ id: "f", state: "stopped" });
    expect((await update({ caseRevision: 1, action: "stop" })).status).toBe(
      200,
    );
    expect(state.set.mock.calls[0]?.[1]).toBe("session-owner");
  });
});
