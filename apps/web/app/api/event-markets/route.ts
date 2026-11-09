import { PublicCatalog } from "../../../../../packages/integrations/src/public-catalog";
const client = new PublicCatalog();
const cache = new Map<
  string,
  { at: number; data: Awaited<ReturnType<PublicCatalog["eventMarkets"]>> }
>();
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const platform =
    new URL(request.url).searchParams.get("platform") ?? "kalshi";
  if (platform !== "kalshi" && platform !== "polymarket")
    return Response.json({ error: "INVALID_PLATFORM" }, { status: 400 });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    return Response.json({ error: "INVALID_EVENT" }, { status: 400 });
  try {
    const key = `${platform}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60000) return Response.json(hit.data);
    const data = await client.eventMarkets(id, platform);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), data });
    return Response.json(data, {
      headers: { "Cache-Control": "public,max-age=30" },
    });
  } catch {
    return Response.json({ error: "EVENT_UNAVAILABLE" }, { status: 502 });
  }
}
