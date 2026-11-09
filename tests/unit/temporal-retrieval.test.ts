import { expect, it } from "vitest";
import {
  parseTemporalRequest,
  resolveCuratedMarketAlias,
} from "../../packages/agent/src/temporal-retrieval";
it("parses only explicit timezone cutoffs and never assumes date end", () => {
  expect(
    parseTemporalRequest(
      "What was known as of 2026-10-29T12:30:00+07:00?",
    ).cutoff?.toISOString(),
  ).toBe("2026-10-29T05:30:00.000Z");
  expect(
    parseTemporalRequest("tính đến 2026-10-29 12:30 UTC").cutoff?.toISOString(),
  ).toBe("2026-10-29T12:30:00.000Z");
  expect(parseTemporalRequest("as of 2026-10-29").status).toBe(
    "clarification_required",
  );
  expect(parseTemporalRequest("as of yesterday").status).toBe(
    "clarification_required",
  );
});
it("requires exact native identity/date when same teams have repeated games", () => {
  const markets = [
    {
      platform: "kalshi" as const,
      nativeId: "KXNBAGAME-26OCT30LALUTA-LAL",
      question: "Los Angeles Lakers vs Utah Jazz",
    },
    {
      platform: "kalshi" as const,
      nativeId: "KXNBAGAME-26NOV01LALUTA-LAL",
      question: "Los Angeles Lakers vs Utah Jazz",
    },
  ];
  expect(resolveCuratedMarketAlias("LAL vs Jazz", markets).status).toBe(
    "ambiguous",
  );
  expect(
    resolveCuratedMarketAlias("LAL vs Jazz on 2026-10-30", markets).market
      ?.nativeId,
  ).toBe(markets[0]?.nativeId);
  expect(
    resolveCuratedMarketAlias("LAL vs Jazz on 2026-10-31", markets).status,
  ).toBe("not_found");
});
it("does not interpret the English verb was as the Washington team ticker", () => {
  expect(
    resolveCuratedMarketAlias(
      "What was my pre-change check in the previous conversation?",
      [],
    ).status,
  ).toBe("unmatched");
  expect(resolveCuratedMarketAlias("WAS vs Hornets", []).status).toBe(
    "not_found",
  );
});
