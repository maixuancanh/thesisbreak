import { it, expect } from "vitest";
import { publicRunState } from "../../packages/db/src/agent-run-control";
import { researchResult } from "../../apps/web/lib/agent-client";
import { MEMORY_COMPARISON_NOTE } from "../../packages/domain/src/memory-comparison";
it("preserves Tatum trace and comparison after reconnect without exposing extra fields", () => {
  const plain = {
    message: "No applicable memory",
    evidenceRefs: [],
    lessonRefs: [],
    proposedChange: null,
  };
  const result = {
    reply: plain,
    trace: [{ tool: "read_tatum_quote", status: "unavailable", count: 0 }],
    sources: [],
    usedLessons: [],
    pick: null,
    memoryState: "account_only",
    memoryComparison: {
      status: "no_applicable_memory",
      experimental: true,
      historyPolicy: "excluded_from_both",
      note: MEMORY_COMPARISON_NOTE,
      withMemory: null,
      withoutMemory: null,
      lessonVersions: [],
      changed: false,
    },
    internalSecret: "must not leak",
  };
  const state = publicRunState({ id: "r", status: "completed", result });
  const parsed = researchResult.parse(state.result);
  expect(parsed.memoryComparison?.status).toBe("no_applicable_memory");
  expect(parsed.trace[0]?.tool).toBe("read_tatum_quote");
  expect(state.result).not.toHaveProperty("internalSecret");
});
it("preserves reason review and authoritative outcome across persisted status", () => {
  const result = {
    reply: {
      message: "Review",
      evidenceRefs: [],
      lessonRefs: [],
      proposedChange: null,
      reasonReview: {
        baseVersion: 1,
        summary: "Unknown",
        claims: [
          {
            claim: "A will win",
            status: "unclear",
            explanation: "No independent facts",
            evidenceRefs: [],
          },
        ],
      },
      retrospective: {
        baseVersion: 1,
        summary: "Outcome does not prove reasoning",
        reasoningLesson: "Wait for official evidence.",
        evidenceRefs: ["final-settlement"],
      },
    },
    trace: [{ tool: "read_settlement", status: "completed", count: 1 }],
    sources: [],
    usedLessons: [],
    pick: { id: "p", version: 1, outcome: "Yes", reason: "Reason" },
    memoryState: "walrus_recalled",
    outcomeReview: {
      outcome: "Yes",
      resolvedAt: "2026-10-26T00:00:00Z",
      pickRecordedAt: "2026-10-25T00:00:00Z",
      sourceRef: "final-settlement",
      baseVersion: 1,
      pickedOutcome: "Yes",
      comparison: "matched",
    },
  };
  expect(
    researchResult.parse(
      publicRunState({ id: "r", status: "completed", result }).result,
    ),
  ).toEqual(result);
});
it("retains completed independent-source replies through status SSE sanitization", () => {
  const result = {
    reply: {
      message: "Official report lists Player Out.",
      evidenceRefs: ["news:nba-official:x"],
      lessonRefs: [],
      proposedChange: null,
    },
    trace: [
      { tool: "read_independent_sources", status: "completed", count: 4 },
    ],
    sources: [
      {
        id: "news:nba-official:x",
        url: "https://official.nba.com",
        retrievedAt: new Date().toISOString(),
      },
    ],
    usedLessons: [],
    pick: null,
    memoryState: "walrus_recalled",
  };
  const state = publicRunState({ id: "run", status: "completed", result });
  expect(researchResult.safeParse(state.result).success).toBe(true);
  expect(state.result).toEqual(result);
});
