import { expect, it } from "vitest";
import { createAgentContext } from "../../packages/agent/src/context";
import {
  independentAgentSources,
  type NewsCheck,
} from "../../packages/integrations/src/news/collect";
const now = new Date("2026-10-29T10:00:00Z");
const base = {
  userId: "owner",
  market: {
    platform: "kalshi" as const,
    nativeId: "x",
    question: "Team wins?",
    outcomes: ["Yes", "No"],
    rules: null,
  },
  pick: null,
  lessons: [],
  now,
};
const evidence = {
  userId: "owner",
  market: { platform: "kalshi" as const, nativeId: "x" },
  id: "official-lineup",
  text: "Explicit starters on official game page",
  publishedAt: null,
  retrievedAt: now.toISOString(),
  kind: "official_event" as const,
};
it("accepts explicit fresh official lineup observation without fabricating publication time", () => {
  const context = createAgentContext({
    ...base,
    evidence: [evidence],
    researchPrerequisites: {
      requiresLineup: true,
      confirmedLineupEvidenceRefs: [evidence.id],
      conflictingEvidence: false,
    },
  });
  expect(context.researchPolicy.readiness.action).toBe("ready");
  expect(context.researchPolicy.evidenceFreshness[0]?.status).toBe(
    "unknown_publication_time",
  );
});
it("never treats an injury report alone as confirmed starters", () => {
  const check: NewsCheck = {
    source: "nba-official",
    state: "available",
    background: false,
    checkedAt: now.toISOString(),
    items: [
      {
        id: "injury",
        url: "https://official.nba.com/injury",
        title: "Injury report",
        text: "Available",
        publishedAt: null,
        retrievedAt: now.toISOString(),
        eventDate: "2026-10-29",
        teams: ["Boston Celtics"],
        confirmedLineup: true,
      },
    ],
  };
  expect(independentAgentSources([check])[1]?.confirmsLineup).toBe(false);
});
it("rejects stale lineup confirmation", () => {
  const context = createAgentContext({
    ...base,
    evidence: [{ ...evidence, retrievedAt: "2026-10-29T09:00:00Z" }],
    researchPrerequisites: {
      requiresLineup: true,
      confirmedLineupEvidenceRefs: [evidence.id],
      conflictingEvidence: false,
    },
  });
  expect(context.researchPolicy.readiness.action).not.toBe("ready");
});
