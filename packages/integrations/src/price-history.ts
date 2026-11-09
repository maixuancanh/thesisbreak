import { z } from "zod";
const candle = z.object({
  end_period_ts: z.number().int().positive(),
  price: z
    .object({ close_dollars: z.string().nullable().optional() })
    .optional(),
});
export function parseKalshiHistory(raw: unknown) {
  const parsed = z
    .object({ candlesticks: z.array(candle).max(10000) })
    .parse(raw);
  const points = new Map<number, number>();
  for (const c of parsed.candlesticks) {
    const value = c.price?.close_dollars;
    if (value === undefined || value === null || !/^\d+(\.\d+)?$/.test(value))
      continue;
    const p = Number(value);
    if (Number.isFinite(p) && p >= 0 && p <= 1) points.set(c.end_period_ts, p);
  }
  return [...points]
    .sort((a, b) => a[0] - b[0])
    .map(([time, price]) => ({ time, price }));
}
