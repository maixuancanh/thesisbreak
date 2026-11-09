import { describe, expect, it } from "vitest";
import { pickListPage } from "../../apps/web/lib/pick-list";
const rows = Array.from({ length: 20 }, (_, i) => ({
  question: `Game ${i}`,
  event_title: "NBA",
  native_id: `market-${i}`,
  platform: "kalshi",
  outcome: "Yes",
  reason: i === 19 ? "official lineup" : "",
  state: i < 15 ? "active" : "paused",
  advice_reviews: i === 2 ? [{ explanation: "Changed source" }] : [],
}));
describe("compact picks", () => {
  it("shows twenty picks on four bounded pages without loss", () => {
    const pages = [1, 2, 3, 4].map((p) => pickListPage(rows, "all", "", p));
    expect(pages.map((p) => p.items.length)).toEqual([6, 6, 6, 2]);
    expect(pages.flatMap((p) => p.items)).toEqual(rows);
  });
  it("filters actual states and available review flags", () => {
    expect(pickListPage(rows, "paused", "", 1).total).toBe(5);
    expect(pickListPage(rows, "review", "", 1).items).toEqual([rows[2]]);
  });
  it("searches reasons and clamps pages when filtering", () => {
    expect(pickListPage(rows, "all", "OFFICIAL LINEUP", 4)).toMatchObject({
      page: 1,
      total: 1,
      start: 1,
      end: 1,
    });
    expect(pickListPage(rows, "active", "official lineup", 1).total).toBe(0);
  });
  it("includes the live following state in the Following filter", () => {
    expect(
      pickListPage([{ ...rows[0]!, state: "following" }], "active", "", 1)
        .total,
    ).toBe(1);
  });
  it("handles empty results", () =>
    expect(pickListPage([], "all", "", 20)).toMatchObject({
      page: 1,
      pages: 1,
      start: 0,
      end: 0,
      total: 0,
    }));
});
