import { describe, it, expect } from "vitest";
import { preferencePage } from "../../apps/web/lib/preference-list";
const rows = Array.from({ length: 20 }, (_, i) => ({
  lesson: {
    status: "active",
    rule: `Preference ${i}`,
    scope: { domain: "Sports", competition: i === 19 ? "NBA" : "Football" },
  },
}));
describe("preference navigation", () => {
  it("bounds twenty records to six per page without dropping or duplicating records", () => {
    const pages = [1, 2, 3, 4].map((p) =>
      preferencePage(rows, "active", "", p),
    );
    expect(pages.map((p) => p.items.length)).toEqual([6, 6, 6, 2]);
    expect(pages.flatMap((p) => p.items)).toEqual(rows);
    expect(pages[3]).toMatchObject({ start: 19, end: 20, total: 20, pages: 4 });
  });
  it("clamps the current page after records disappear or filtering narrows results", () => {
    expect(preferencePage(rows, "active", "nba", 4)).toMatchObject({
      page: 1,
      total: 1,
      start: 1,
      end: 1,
    });
  });
  it("searches case insensitively within the selected status only", () => {
    expect(preferencePage(rows, "paused", "sports", 1).total).toBe(0);
    expect(preferencePage(rows, "active", "  NBA  ", 1).items).toEqual([
      rows[19],
    ]);
  });
  it("handles no matches without an invalid page range", () => {
    expect(preferencePage(rows, "active", "missing", 10)).toMatchObject({
      items: [],
      page: 1,
      start: 0,
      end: 0,
      pages: 1,
      total: 0,
    });
  });
});
