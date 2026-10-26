import { it, expect, vi } from "vitest";
import { readReviewSettlement } from "../../packages/db/src/review-settlement";
import { settlementComparison } from "../../packages/domain/src/reason-review";
const pick = {
  userId: "owner",
  pickId: "pick",
  version: 2,
  market: { platform: "kalshi" as const, nativeId: "TEST" },
  outcome: "Yes",
  reason: "Reason",
};
const final = { outcome: "Yes", resolvedAt: "2026-10-26T01:00:00Z" };
it("only uses verified public Kalshi finality and owner/current-version timestamp", async () => {
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(sql).toContain("p.user_id=$2");
    expect(values).toHaveLength(5);
    return {
      rows: [{ created_at: "2026-10-25T00:00:00Z" }],
    };
  });
  const result = await readReviewSettlement({ query }, pick, {
    provider: "kalshi-public",
    resolution: final,
  });
  expect(result).toMatchObject({
    ...final,
    pickRecordedAt: "2026-10-25T00:00:00.000Z",
    sourceRef: "final-settlement",
  });
  expect(query.mock.calls[0]?.[1]).toEqual([
    "pick",
    "owner",
    2,
    "kalshi",
    "TEST",
  ]);
  expect(
    await readReviewSettlement({ query }, pick, {
      provider: "tatum",
      resolution: final,
    }),
  ).toBeNull();
  expect(
    await readReviewSettlement({ query: async () => ({ rows: [] }) }, pick, {
      provider: "kalshi-public",
      resolution: final,
    }),
  ).toBeNull();
});
it("never scores entries created at or after the final result", () => {
  expect(
    settlementComparison("Yes", {
      ...final,
      pickRecordedAt: final.resolvedAt,
      sourceRef: "s",
    }),
  ).toBe("not_scored");
  expect(
    settlementComparison("No", {
      ...final,
      pickRecordedAt: "2026-10-25T00:00:00Z",
      sourceRef: "s",
    }),
  ).toBe("did_not_match");
});
