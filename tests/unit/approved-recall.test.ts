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
