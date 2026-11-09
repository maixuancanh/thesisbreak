import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { journeyHumanDecisionPacket } from "../../packages/agent/src/journey-human-packet";
import {
  journeyHash,
  type ApplicationJourneyFixture,
} from "../../packages/agent/src/application-journey";

const fixture: ApplicationJourneyFixture = {
  id: "review-case",
  ownerId: "abstract-owner",
  namespace: "eval:test",
  now: "2026-01-01T00:00:00Z",
  eventId: "event",
  steps: [
    {
      id: "candidate",
      actor: "agent",
      violations: [],
      action: {
        type: "propose_lesson",
        lessonId: "lesson",
        resultId: "result",
        resultVersion: 1,
        evidenceIds: [],
      },
    },
    {
      id: "review",
      actor: "synthetic_user",
      violations: [],
      action: {
        type: "user_review",
        lessonId: "lesson",
        decision: "approve",
        reviewer: "synthetic_user",
      },
    },
  ],
};
function setup() {
  const candidate = {
    id: "owned-candidate",
    version: 1,
    payload: { rule: "Check evidence" },
    status: "pending_review",
    lesson_id: null,
  };
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: params[0] === "actual-owner" ? [candidate] : [],
  }));
  return {
    candidate,
    query,
    input: {
      pool: { query } as unknown as Pool,
      runId: "eval:packet",
      fixture,
      step: fixture.steps[1]!,
      binding: { review: { action: "approve", baseVersion: 1 } },
      state: {
        ownerId: "actual-owner",
        refs: { candidate: { id: candidate.id } },
      },
    },
  };
}
describe("pending human decision packets", () => {
  it("preserves unresolved or unknown candidates as a diagnostic and null hash", async () => {
    const { input } = setup();
    for (const refs of [{}, { candidate: { id: "unknown-candidate" } }]) {
      const packet = await journeyHumanDecisionPacket({
        ...input,
        state: { ...input.state, refs },
      });
      expect(packet.actionHash).toBeNull();
      expect(packet.resolvedBinding).toBeNull();
      expect(packet.diagnostic).toMatch(
        /APPLICATION_CANDIDATE_REQUIRED|APPLICATION_REVIEW_TARGET_NOT_CURRENT/,
      );
      expect(packet).not.toHaveProperty("actor");
      expect(packet).not.toHaveProperty("decisionId");
    }
    const unresolved = await journeyHumanDecisionPacket({
      ...input,
      binding: { review: "$ref:missing.review" },
    });
    expect(unresolved.actionHash).toBeNull();
    expect(unresolved.diagnostic).toBe("MISSING_JOURNEY_REFERENCE");
  });
  it("hashes the exact owner-scoped candidate version and content using executor binding", async () => {
    const { input, query, candidate } = setup();
    const packet = await journeyHumanDecisionPacket(input);
    const resolvedBinding = {
      ...input.binding,
      reviewAuthority: {
        candidate: {
          id: candidate.id,
          version: 1,
          status: candidate.status,
          payloadHash: journeyHash(candidate.payload),
        },
        lesson: null,
      },
    };
    expect(query).toHaveBeenCalledWith(expect.any(String), ["actual-owner"]);
    expect(packet.resolvedBinding).toEqual(resolvedBinding);
    // Property order follows the executor's concrete resolver, so use its returned value.
    expect(packet.actionHash).toBe(
      journeyHash([
        input.runId,
        fixture.id,
        input.step.action,
        packet.resolvedBinding,
      ]),
    );
    expect(packet.diagnostic).toBeNull();
    candidate.payload.rule = "Changed content";
    const changed = await journeyHumanDecisionPacket(input);
    expect(changed.actionHash).not.toBe(packet.actionHash);
  });
  it("invalidates an old base version and changes the hash for the new reviewed version", async () => {
    const { input, candidate } = setup();
    const initial = await journeyHumanDecisionPacket(input);
    candidate.version = 2;
    expect((await journeyHumanDecisionPacket(input)).actionHash).toBeNull();
    input.binding.review.baseVersion = 2;
    const updated = await journeyHumanDecisionPacket(input);
    expect(updated.actionHash).toEqual(expect.any(String));
    expect(updated.actionHash).not.toBe(initial.actionHash);
  });
});
