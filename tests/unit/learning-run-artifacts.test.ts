import { expect, it, vi } from "vitest";
import {
  publicAgentResult,
  publicAgentRuns,
} from "../../packages/agent/src/public-result";
import {
  buildRunDossier,
  refreshRunDossier,
} from "../../packages/agent/src/dossier-builder";
import { runOneReceiptPreparation } from "../../packages/integrations/src/run-receipt-worker";
import { runOneEventDossierJob } from "../../packages/integrations/src/event-dossier-worker";
import { runResearch } from "../../packages/agent/src/runtime";
const run = {
  learningEventId: "e",
  learningEvidence: [
    {
      id: "official",
      text: "No lineup has been published.",
      origin: "tool_result",
      eventId: "e",
      publishedAt: null,
      occurredAt: null,
      retrievedAt: "2026-10-30T06:00:00Z",
      sourceOrigin: "official-origin",
    },
  ],
  verifiedLearningLessons: [],
  learningSourceMemories: [],
  pick: null,
  appliedConditions: [],
  learningGate: { ready: false, reasons: ["official_lineup_required"] },
  recalledSources: [],
};
it("keeps exact tool wording and dependency hash in scoped dossier", () => {
  const d = buildRunDossier("u", run, "2026-10-30T06:00:00Z");
  expect(d.blocks.evidence?.text).toContain("No lineup");
  expect(d.blocks.evidence?.dependencies[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
});
it("refreshes only blocks affected by exact changed source dependencies", () => {
  const old = buildRunDossier("u", run, "2026-10-30T06:00:00Z");
  const changed = {
    ...run,
    learningEvidence: run.learningEvidence.map((e) => ({
      ...e,
      text: "Official lineup now published.",
    })),
  };
  const result = refreshRunDossier(old, "u", changed, "2026-10-30T06:01:00Z");
  expect(result?.changedBlocks).toEqual(["evidence", "unknowns"]);
  expect(result?.dossier.blocks.savedView).toEqual(old.blocks.savedView);
  expect(result?.dossier.blocks.conditions).toEqual(old.blocks.conditions);
  expect(result?.dossier.blocks.sourceHistory).toEqual(
    old.blocks.sourceHistory,
  );
  expect(result?.dossier.blocks.evidence?.text).toContain("now published");
  expect(refreshRunDossier(old, "u", run, "2026-10-30T06:01:00Z")).toBeNull();
});
it("rejects foreign/future/duplicate supporting originals rather than refreshing", () => {
  expect(() =>
    buildRunDossier(
      "u",
      {
        ...run,
        learningEvidence: run.learningEvidence.map((e) => ({
          ...e,
          eventId: "foreign",
        })),
      },
      "2026-10-30T06:00:00Z",
    ),
  ).toThrow("SOURCE_EVENT_MISMATCH");
  expect(() => buildRunDossier("u", run, "2026-10-30T05:00:00Z")).toThrow(
    "SOURCE_AFTER_CHECK",
  );
  expect(() =>
    buildRunDossier(
      "u",
      {
        ...run,
        learningEvidence: [...run.learningEvidence, ...run.learningEvidence],
      },
      "2026-10-30T06:00:00Z",
    ),
  ).toThrow("DUPLICATE_SOURCE");
});
it("public fresh and replay results omit internal originals/proofs", () => {
  const result = {
    ...run,
    verifiedLearningMemories: [{ hash: "secret" }],
    reply: { message: "Public" },
  };
  expect(publicAgentResult(result)).not.toHaveProperty("learningEvidence");
  expect(publicAgentResult(result)).not.toHaveProperty(
    "verifiedLearningLessons",
  );
  expect(publicAgentRuns([{ result }])[0]?.result).not.toHaveProperty(
    "learningSourceMemories",
  );
});
it("empty durable queues do not call model or mutate receipt/dossier state", async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as never;
  expect(await runOneReceiptPreparation(pool)).toEqual({
    checked: 0,
    completed: 0,
  });
  expect(await runOneEventDossierJob(pool)).toEqual({
    checked: 0,
    completed: 0,
  });
  expect(query.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it("runtime captures actual tools and excludes recalled snapshot from extraction view", async () => {
  const now = new Date("2026-10-30T06:00:00Z");
  const result = await runResearch(
    {
      userId: "u",
      market: {
        platform: "kalshi",
        nativeId: "n",
        question: "Win?",
        outcomes: ["Yes", "No"],
        rules: null,
      },
      message: "Review",
      history: [],
      domain: "sports",
      eventId: "e",
      now,
    },
    {
      plan: async () => ({ tools: ["compare_snapshot"] }),
      generate: async () => ({
        message: "Need evidence",
        evidenceRefs: [],
        lessonRefs: [],
        proposedChange: null,
      }),
      readPick: async () => null,
      readLessons: async () => [],
      readComparison: async () => [
        {
          id: "saved-snapshot",
          kind: "snapshot",
          text: "Replayed old snapshot",
          retrievedAt: now.toISOString(),
          url: "https://example.com",
        },
      ],
      marketSource: {
        id: "market-source",
        text: "Actual tool market response",
        retrievedAt: now.toISOString(),
        url: "https://example.com",
      },
    },
  );
  expect(result.learningEvidence.map((e) => e.id)).toEqual(["market-source"]);
  expect(result.learningEventId).toBe("e");
});
