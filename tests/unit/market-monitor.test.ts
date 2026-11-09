import { describe, it, expect } from "vitest";
import {
  compareMarketObservation,
  monitorCreateSchema,
} from "../../packages/domain/src/market-monitor";
const old = {
  rules: "Settle using the official result",
  prices: [
    { name: "Yes", price: 0.4 },
    { name: "No", price: 0.6 },
  ],
  sourceUrl: "https://kalshi.com/markets/test",
  fetchedAt: "2026-10-25T00:00:00Z",
};
describe("source-bound market observation", () => {
  it("reports a final outcome even without prices and records later corrections", () => {
    const resolution = { outcome: "Yes", resolvedAt: "2026-10-25T00:00:00Z" };
    const next = {
      ...old,
      resolution,
      prices: old.prices.map((p) => ({ ...p, price: null })),
    };
    expect(compareMarketObservation(old, next).kind).toBe("market_resolved");
    expect(compareMarketObservation(next, next).kind).toBe("unchanged");
    expect(
      compareMarketObservation(next, {
        ...next,
        resolution: { ...resolution, outcome: "No" },
      }).kind,
    ).toBe("resolution_corrected");
    expect(() =>
      compareMarketObservation(old, {
        ...next,
        resolution: { ...resolution, outcome: "Other" },
      }),
    ).toThrow();
  });
  it("can compare a supplied Yes quote while keeping an unavailable No quote unknown", () => {
    const previous = {
      ...old,
      prices: [
        { name: "Yes", price: 0.4 },
        { name: "No", price: null },
      ],
    };
    const next = {
      ...previous,
      prices: [
        { name: "Yes", price: 0.5 },
        { name: "No", price: null },
      ],
    };
    expect(compareMarketObservation(previous, next).kind).toBe("price_changed");
    expect(
      compareMarketObservation(previous, {
        ...next,
        prices: next.prices.map((p) => ({ ...p, price: null })),
      }).kind,
    ).toBe("source_incomplete");
  });
  it("does not equate price movement with a broken reason", () => {
    const result = compareMarketObservation(old, {
      ...old,
      prices: [
        { name: "Yes", price: 0.8 },
        { name: "No", price: 0.2 },
      ],
      fetchedAt: "2026-10-25T00:05:00Z",
    });
    expect(result.kind).toBe("price_changed");
    expect(result.reasonChanged).toBe(false);
  });
  it("requires review of changed settlement rules, not an automatic pick change", () => {
    expect(
      compareMarketObservation(old, {
        ...old,
        rules: "Different official settlement terms",
      }),
    ).toMatchObject({ kind: "rules_changed", reasonChanged: false });
    expect(
      compareMarketObservation(old, { ...old, rules: null }),
    ).toMatchObject({ kind: "source_incomplete", reasonChanged: false });
  });
  it("deduplicates unchanged observations and rejects stale or foreign sources", () => {
    expect(compareMarketObservation(old, old).kind).toBe("unchanged");
    expect(
      compareMarketObservation(old, {
        ...old,
        fetchedAt: "2026-10-24T00:00:00Z",
      }).kind,
    ).toBe("source_delayed");
    expect(() =>
      compareMarketObservation(old, {
        ...old,
        sourceUrl: "https://evil.test/x",
      }),
    ).toThrow("SOURCE_CHANGED");
  });
  it("requires explicit bounded monitoring approval", () => {
    expect(
      monitorCreateSchema.safeParse({
        pickId: "p",
        baseVersion: 1,
        requestId: crypto.randomUUID(),
        confirmed: true,
        durationHours: 24,
      }).success,
    ).toBe(true);
    expect(
      monitorCreateSchema.safeParse({
        pickId: "p",
        baseVersion: 1,
        requestId: crypto.randomUUID(),
        confirmed: false,
        durationHours: 10000,
      }).success,
    ).toBe(false);
  });
});
