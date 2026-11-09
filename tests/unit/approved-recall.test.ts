import { describe, it, expect, vi } from "vitest";
import { recallApprovedContext } from "../../packages/agent/src/approved-recall";
const lesson = {
  id: "l",
  userId: "u",
  version: 1,
  parentVersion: null,
  rule: "Differentiate price changes from confirmed sports news",
  scope: { domain: "Sports" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  supersededBy: null,
};
const record = { logicalId: "l", type: "lesson", version: 1, payload: lesson };
describe("scoped approved recall reconciliation", () => {
  it.each(["exact", "wrong-hash", "wrong-blob", "wrong-owner"])(
    "only exact fresh receipt may reorder authorized lessons: %s",
    async (mode) => {
      const other = { ...lesson, id: "a", rule: lesson.rule };
      const pointer = {
        ownerId: "u",
        memoryId: "l",
        version: 1,
        sha256: "a".repeat(64),
        blobId: "blob",
      };
      const envelope = {
        ...record,
        schema: 1 as const,
        userId: "u",
        recordedAt: lesson.effectiveAt,
        hash: "a".repeat(64),
      };
      const result = await recallApprovedContext({
        query: "news",
        userId: "u",
        domain: "Sports",
        now: new Date(),
        loadCurrent: async () => [other, lesson],
        indexCandidates: async () => [
          {
            ...pointer,
            ...(mode === "wrong-hash" ? { sha256: "b".repeat(64) } : {}),
            ...(mode === "wrong-blob" ? { blobId: "other" } : {}),
            ...(mode === "wrong-owner" ? { ownerId: "foreign" } : {}),
          },
        ],
        recall: async () => ({
          records: [record, { ...record, logicalId: "a", payload: other }],
          sources: [{ record: envelope, blobId: "blob" }],
        }),
      });
      expect(result.map((l) => l.id)).toEqual(
        mode === "exact" ? ["l", "a"] : ["a", "l"],
      );
    },
  );
  it("rechecks current authority after an optional index lookup pauses a lesson", async () => {
    let paused = false;
    const result = await recallApprovedContext({
      query: "lineup",
      userId: "u",
      domain: "Sports",
      now: new Date(),
      loadCurrent: async () => [
        { ...lesson, status: paused ? "paused" : "active" },
      ],
      recall: async () => ({ records: [record] }),
      indexCandidates: async () => {
        paused = true;
        return [
          {
            ownerId: "u",
            memoryId: "l",
            version: 1,
            sha256: "a".repeat(64),
            blobId: "blob",
          },
        ];
      },
    });
    expect(result).toEqual([]);
  });
  it.each([
    { domain: "Politics" },
    { domain: "Sports", competition: "EuroLeague" },
  ])(
    "excludes a verified procedure with a different learned scope: %j",
    async (learningScope) => {
      const scoped = { ...lesson, learningScope };
      const result = await recallApprovedContext({
        query: lesson.rule,
        userId: "u",
        domain: "Sports",
        competition: "NBA",
        now: new Date("2026-10-31T00:00:00Z"),
        loadCurrent: async () => [scoped],
        recall: async () => ({ records: [{ ...record, payload: scoped }] }),
      });
      expect(result).toEqual([]);
    },
  );
  it("finds a current lesson by its text when a new question misses it", async () => {
    const recall = vi.fn(async (q: string) => ({
      records: q === lesson.rule ? [record] : [],
    }));
    const result = await recallApprovedContext({
      query: "Explain the current contract",
      userId: "u",
      domain: "Sports",
      now: new Date(),
      loadCurrent: async () => [lesson],
      recall,
    });
    expect(result).toHaveLength(1);
    expect(recall).toHaveBeenCalledWith(lesson.rule);
  });
  it("never fills a remote miss from the local lesson alone", async () => {
    expect(
      await recallApprovedContext({
        query: "q",
        userId: "u",
        domain: "Sports",
        now: new Date(),
        loadCurrent: async () => [lesson],
        recall: async () => ({ records: [] }),
      }),
    ).toEqual([]);
  });
  it("rechecks authority after remote reads and ignores wrong scopes", async () => {
    let count = 0;
    const recall = vi.fn(async () => ({ records: [record] }));
    expect(
      await recallApprovedContext({
        query: "q",
        userId: "u",
        domain: "Sports",
        now: new Date(),
        loadCurrent: async () =>
          ++count === 1 ? [lesson] : [{ ...lesson, status: "paused" }],
        recall,
      }),
    ).toEqual([]);
    recall.mockClear();
    await recallApprovedContext({
      query: "q",
      userId: "u",
      domain: "Politics",
      now: new Date(),
      loadCurrent: async () => [lesson],
      recall,
    });
    expect(recall).toHaveBeenCalledTimes(1);
  });
});
