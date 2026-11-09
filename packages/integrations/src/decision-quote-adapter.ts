import { createHash } from "node:crypto";
import { z } from "zod";
import { observedDecisionQuoteSchema } from "../../domain/src/decision-evidence-assessment";
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number)
  .refine(Number.isFinite);
const price = decimal.refine((n) => n >= 0 && n <= 1);
const book = z.object({
  ticker: z.string().min(1).max(128),
  status: z.literal("active"),
  yes_bid_dollars: price,
  yes_ask_dollars: price,
  yes_bid_size_fp: decimal.refine((n) => n > 0),
  yes_ask_size_fp: decimal.refine((n) => n > 0),
  rules_primary: z.string().optional(),
  rules_secondary: z.string().optional(),
});
/** Official Kalshi Get Market dollar prices and fixed-point displayed sizes.
 * https://docs.kalshi.com/api-reference/market/get-market
 * A current book snapshot is observed at retrieval, never labeled as trade time.
 * Gamma outcome_price and Tatum catalog price do not establish quote semantics. */
export function normalizePublicDecisionQuotes(
  value: unknown,
  platform: "kalshi" | "polymarket",
  observedAt: string,
) {
  if (platform !== "kalshi") return [];
  const parsed = book.safeParse(value);
  if (
    !parsed.success ||
    !z.iso.datetime({ offset: true }).safeParse(observedAt).success
  )
    return [];
  const r = parsed.data;
  const rules = [r.rules_primary, r.rules_secondary]
    .filter(Boolean)
    .join("\n\n");
  if (!rules.trim() || r.yes_bid_dollars > r.yes_ask_dollars) return [];
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const q = {
    provider: "kalshi-public",
    marketId: r.ticker,
    outcomeId: "Yes",
    quoteType: "mid" as const,
    probability:
      Math.round(((r.yes_bid_dollars + r.yes_ask_dollars) * 1e8) / 2) / 1e8,
    spread: Math.round((r.yes_ask_dollars - r.yes_bid_dollars) * 1e8) / 1e8,
    observedAt,
    rulesHash: hash(rules),
    status: "open" as const,
    liquidityAvailable: true,
  };
  return [
    observedDecisionQuoteSchema.parse({
      ...q,
      id: `quote:${hash(JSON.stringify(q))}`,
    }),
  ];
}
