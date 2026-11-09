import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { normalizeBookmakerEvent } from "../packages/integrations/src/bookmaker";
import { compareBookmakerWithPolygon } from "../packages/integrations/src/bookmaker-market-comparison";
import {
  readPolygonActivity,
  readTatumOutcomeTokens,
} from "../packages/integrations/src/tatum/polygon-activity";

const rule = z.object({
  sourceUrl: z.url(),
  reviewedAt: z.iso.datetime(),
  overtime: z.string(),
  postponement: z.string(),
  abandonment: z.string(),
});
const schema = z.object({
  marketId: z.string().regex(/^0x[\da-f]{64}$/i),
  bookmakerKey: z.string().min(1),
  bookmakerFetchedAt: z.iso.datetime(),
  bookmakerEvent: z.unknown(),
  mapping: z.object({
    home: z.string(),
    away: z.string(),
    scheduledAt: z.iso.datetime(),
    marketType: z.literal("full_game_winner"),
    yesOutcome: z.string(),
    noOutcome: z.string(),
    sourceUrl: z.url(),
    reviewedAt: z.iso.datetime(),
  }),
  rules: z.object({ bookmaker: rule, market: rule }).nullable(),
});

async function main() {
  const file = process.argv[2];
  const apiKey = process.env.TATUM_API_KEY;
  if (!file || !apiKey)
    throw Error("Provide a reviewed input JSON path and TATUM_API_KEY.");
  const input = schema.parse(JSON.parse(readFileSync(file, "utf8")));
  const bookmaker = normalizeBookmakerEvent(
    input.bookmakerEvent,
    new Date(input.bookmakerFetchedAt),
  );
  const quotes = bookmaker.quotes.filter(
    (quote) => quote.bookmaker === input.bookmakerKey,
  );
  if (quotes.length !== 1)
    throw Error("Expected one pre-event bookmaker quote.");
  const outcomes = await readTatumOutcomeTokens(apiKey, input.marketId);
  const activity = await readPolygonActivity({
    apiKey,
    conditionId: input.marketId,
    outcomes,
    around: new Date(quotes[0]!.asOf),
    reserve: () => delay(700),
  });
  const comparison = compareBookmakerWithPolygon({
    bookmaker,
    bookmakerKey: input.bookmakerKey,
    marketId: input.marketId,
    activity,
    mapping: {
      ...input.mapping,
      marketId: input.marketId,
      platform: "polymarket",
    },
    rules: input.rules,
    now: new Date(),
  });
  process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Comparison unavailable.",
  );
  process.exitCode = 1;
});
