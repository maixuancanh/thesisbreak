import { z } from "zod";
import { parseKalshiHistory } from "../../../../../packages/integrations/src/price-history";
import { PublicCatalog } from "../../../../../packages/integrations/src/public-catalog";
const catalog = new PublicCatalog();
export const runtime = "nodejs";
const query = z
  .object({
    platform: z.enum(["kalshi", "polymarket"]),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    range: z.enum(["1H", "6H", "1D", "1W", "1M", "ALL"]).default("1W"),
  })
  .strict();
const ranges = {
  "1H": 3600,
  "6H": 21600,
  "1D": 86400,
  "1W": 604800,
  "1M": 2592000,
  ALL: 7776000,
};
const cache = new Map<
  string,
  {
    at: number;
    points: { time: number; price: number }[];
    noPoints?: { time: number; price: number }[];
    basis: "trade_close" | "token_price";
  }
>();
export async function GET(request: Request) {
  const parsed = query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success)
    return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
  const { platform, id, range } = parsed.data;
  const key = JSON.stringify(parsed.data),
    hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000)
    return Response.json(
      {
        points: hit.points,
        noPoints: hit.noPoints,
        basis: hit.basis,
        platform,
      },
      { headers: { "Cache-Control": "public,max-age=30" } },
    );
  const end = Math.floor(Date.now() / 1000),
    period = range === "1H" || range === "6H" ? 1 : range === "ALL" ? 1440 : 60;
  const params = new URLSearchParams({
    start_ts: String(end - ranges[range]),
    end_ts: String(end),
    period_interval: String(period),
  });
  try {
    if (platform === "polymarket") {
      const data = await catalog.polymarketHistory(id, range);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), ...data });
      return Response.json(
        { ...data, platform },
        { headers: { "Cache-Control": "public,max-age=30" } },
      );
    }
    const series = id.split("-")[0]!;
    const r = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(id)}/candlesticks?${params}`,
      { signal: AbortSignal.timeout(12000), redirect: "error" },
    );
    if (!r.ok) throw Error();
    const points = parseKalshiHistory(await r.json());
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), points, basis: "trade_close" });
    return Response.json(
      { points, basis: "trade_close", platform },
      { headers: { "Cache-Control": "public,max-age=30" } },
    );
  } catch {
    return Response.json({ error: "HISTORY_UNAVAILABLE" }, { status: 502 });
  }
}
