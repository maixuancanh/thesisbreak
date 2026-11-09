import { expect, it } from "vitest";
import {
  researchResult,
  transcriptRows,
} from "../../apps/web/lib/agent-client";
const receipt = {
  checkId: "official_lineup",
  procedureVersionId: "official-lineup-v1",
  tool: "read_independent_sources",
  status: "passed",
  evidenceIds: ["official"],
  checkedAt: "2026-11-03T12:00:00Z",
};
const base = {
  reply: {
    message: "Fixture only",
    evidenceRefs: ["official"],
    lessonRefs: [],
    proposedChange: null,
  },
  trace: [],
  sources: [],
  usedLessons: [],
  pick: null,
  memoryState: "fixture",
  procedureChecks: {
    ready: true,
    receipts: [receipt],
    calls: 1,
    raw: [
      {
        tool: "read_independent_sources",
        sources: [{ id: "official", text: "private raw" }],
        error: null,
      },
    ],
  },
};
it("keeps receipt evidence in live response and refreshed saved transcript", () => {
  const parsed = researchResult.parse(base);
  expect(parsed.procedureChecks?.receipts[0]).toEqual(receipt);
  expect(parsed.procedureChecks).not.toHaveProperty("raw");
  const rows = transcriptRows({
    data: [
      {
        id: "saved-run",
        message: "question",
        status: "completed",
        result: base,
        created_at: receipt.checkedAt,
      },
    ],
  });
  expect(rows[0]?.result?.procedureChecks).toEqual(parsed.procedureChecks);
});
it("legacy saved replies remain parseable without procedure checks", () => {
  const { procedureChecks: unused, ...legacy } = base;
  void unused;
  expect(researchResult.parse(legacy).procedureChecks).toBeUndefined();
});
it("a passed receipt cannot survive client parsing without evidence", () => {
  expect(
    researchResult.safeParse({
      ...base,
      procedureChecks: {
        ready: true,
        calls: 1,
        receipts: [{ ...receipt, evidenceIds: [] }],
      },
    }).success,
  ).toBe(false);
});
