import { expect, it } from "vitest";
import {
  aggregateHabits,
  selectApplicableLessons,
} from "../../packages/domain/src/research-memory";
const lesson = {
  id: "l",
  userId: "a",
  version: 2,
  parentVersion: 1,
  rule: "Check evidence",
  scope: { domain: "Sports" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-01-01T00:00:00Z",
  expiresAt: null,
  supersededBy: null,
};
it("rechecks owner, current version, status and exact scope", () => {
  const context = {
    userId: "a",
    domain: "Sports",
    now: new Date("2026-10-27"),
  };
  expect(
    selectApplicableLessons([{ currentVersion: 2, lesson }], context),
  ).toHaveLength(1);
  for (const change of [
    { userId: "b" },
    { status: "paused" },
    { status: "retired" },
    { version: 1, parentVersion: null },
    { scope: { domain: "Politics" } },
  ])
    expect(
      selectApplicableLessons(
        [{ currentVersion: 2, lesson: { ...lesson, ...change } }],
        context,
      ),
    ).toEqual([]);
});
it("requires two distinct owned native cases and never labels a loss a reasoning error", () => {
  const claim = {
    claim: " Official evidence   is missing ",
    status: "unclear" as const,
    explanation: "Unknown",
    evidenceRefs: ["s"],
  };
  const sample = {
    userId: "a",
    platform: "kalshi" as const,
    nativeId: "ONE",
    runId: "r1",
    pickId: "p1",
    pickVersion: 1,
    recordedAt: "2026-10-27T00:00:00Z",
    claims: [claim],
    sources: [
      {
        id: "s",
        url: "https://example.com",
        retrievedAt: "2026-10-27T00:00:00Z",
      },
    ],
  };
  expect(
    aggregateHabits([sample, { ...sample, runId: "r2" }], "a").patterns,
  ).toEqual([]);
  expect(
    aggregateHabits([sample, { ...sample, userId: "b", nativeId: "TWO" }], "a")
      .patterns,
  ).toEqual([]);
  const result = aggregateHabits(
    [sample, { ...sample, runId: "r3", pickId: "p2", nativeId: "TWO" }],
    "a",
  );
  expect(result.patterns[0]?.cases).toHaveLength(2);
  expect(result.patterns[0]?.normalizedClaim).toBe(
    "official evidence is missing",
  );
  expect(result.patterns[0]?.cases[0]?.status).toBe("unclear");
});
