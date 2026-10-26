import { describe, expect, it } from "vitest";
import {
  participantConditions,
  filterMarkets,
  groupEvents,
  marketIdentity,
  validMarketDraft,
} from "../../apps/web/lib/event-presentation";
import type { LiveMarket } from "../../apps/web/lib/live-market";
const market = (id: string, changes: Partial<LiveMarket> = {}): LiveMarket => ({
  id,
  platform: "kalshi",
  question: `Condition ${id}`,
  eventId: "event",
  eventTitle: "Actual event",
  outcomes: [
    { name: "Yes", price: 0.4 },
    { name: "No", price: 0.55 },
  ],
  rules: null,
  closeTime: null,
  updatedAt: null,
  fetchedAt: "2026-10-23",
  sourceUrl: null,
  ...changes,
});
describe("event presentation", () => {
  it("preserves distinct conditions and independent native outcome prices", () => {
    const a = market("a"),
      b = market("b");
    const groups = groupEvents([a, b], "public");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.markets).toEqual([a, b]);
    expect(groups[0]?.markets[0]?.outcomes[1]?.price).toBe(0.55);
  });
  it("separates platform collisions, missing event ids, and event/native collisions", () => {
    expect(
      groupEvents(
        [
          market("a"),
          market("b", { platform: "polymarket" }),
          market("event", { eventId: null }),
          market("d", { eventId: null }),
        ],
        "public",
      ),
    ).toHaveLength(4);
    expect(marketIdentity(market("a"), "public")).not.toBe(
      marketIdentity(market("a"), "tatum"),
    );
  });
  it("filters only verified categories and matching loaded conditions", () => {
    const rows = [
      market("a", { category: "Sports" }),
      market("b", { category: null }),
    ];
    expect(filterMarkets(rows, "Condition a", "Sports")).toEqual([rows[0]]);
    expect(filterMarkets(rows, "", "Finance")).toEqual([]);
  });
  it("maps winner buttons to native Yes contracts only for explicit exclusive game events",()=>{
    const a=market("a",{conditionLabel:"Cleveland",mutuallyExclusive:true,marketScope:"Game"});
    const b=market("b",{conditionLabel:"Philadelphia",mutuallyExclusive:true,marketScope:"Game"});
    expect(participantConditions([a,b])?.map(p=>[p.label,p.market.id,p.outcome.name])).toEqual([["Cleveland","a","Yes"],["Philadelphia","b","Yes"]]);
    expect(participantConditions([a,{...b,marketScope:"Spread"}])).toBeNull();
    expect(participantConditions([a,{...b,mutuallyExclusive:false}])).toBeNull();
    expect(participantConditions([a,{...b,conditionLabel:"Cleveland"}])).toBeNull();
  });
  it("rejects malformed drafts and clears outcomes absent from native contract", () => {
    expect(validMarketDraft('{"outcome":"Yes"}', market("a"))).toBeNull();
    expect(
      validMarketDraft(
        JSON.stringify({
          outcome: "Invented",
          reason: "kept",
          composer: "draft",
        }),
        market("a"),
      ),
    ).toEqual({ outcome: "", reason: "kept", composer: "draft" });
    expect(
      validMarketDraft(
        JSON.stringify({
          outcome: "Yes",
          reason: "r",
          composer: "x",
          foreign: true,
        }),
        market("a"),
      ),
    ).toBeNull();
  });
});
