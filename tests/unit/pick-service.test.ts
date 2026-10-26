import { describe, expect, it, vi } from "vitest";
import {
  parsePickCreate,
  verifiedSnapshot,
} from "../../apps/web/lib/server/pick-service";
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const policy = await import("../../apps/web/lib/server/auth-policy");
  return { ...policy, requireUser: vi.fn() };
});
const market = {
  platform: "kalshi",
  id: "TEST",
  eventId: null,
  question: "Fixture question?",
  outcomes: [
    { name: "Up", price: 0.4 },
    { name: "Down", price: 0.6 },
  ],
  rules: "Fixture settlement rules",
  fetchedAt: "2026-10-22T00:00:00Z",
  priceAsOf: null,
  closeTime: null,
  source: { url: "https://kalshi.com/markets/test" },
};
describe("server pick input boundary", () => {
  it("rejects client identity, rules and invented outcomes", () => {
    expect(() =>
      parsePickCreate({
        platform: "kalshi",
        nativeId: "TEST",
        outcome: "Up",
        reason: "A reason",
        requestId: "a",
        userId: "victim",
      }),
    ).toThrow();
    expect(() => verifiedSnapshot(market, "YES")).toThrow(
      "OUTCOME_NOT_IN_MARKET",
    );
  });
  it("accepts a selected public source and an optional reason, preserving unavailable prices", () => {
    const input = parsePickCreate({platform:"kalshi",nativeId:"TEST",outcome:"Down",reason:"",provider:"public",requestId:"retry"});
    expect(input.provider).toBe("public");
    expect(input.reason).toBe("");
    expect(verifiedSnapshot({...market,outcomes:[{name:"Up",price:0.4},{name:"Down",price:null}]},"Down").outcomes[1]?.price).toBeNull();
  });
  it("retains absent price timestamp and hashes server rules", () => {
    const snapshot = verifiedSnapshot(market, "Up");
    expect(snapshot.priceAsOf).toBeNull();
    expect(snapshot.rulesHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifiedSnapshot({ ...market, rules: null }, "Up")).toThrow(
      "MARKET_RULES_UNAVAILABLE",
    );
  });
});
