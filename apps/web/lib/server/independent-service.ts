import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, AuthError } from "./auth";
import { readLiveCatalog, liveQuerySchema } from "./live-catalog";
import { livePageSchema } from "../live-market";
import { collectIndependent } from "../../../../packages/integrations/src/news/collect";
import {
  saveIndependentChecks,
  readIndependentChecks,
} from "../../../../packages/db/src/independent-evidence";
let pool: Pool | undefined;
function db() {
  return (pool ??= new Pool({ connectionString: process.env.DATABASE_URL }));
}
export async function loadIndependent(m: {
  platform: "kalshi" | "polymarket";
  nativeId: string;
  eventId?: string | null;
}) {
  const cached = await readIndependentChecks(db(), m);
  if (
    cached.length &&
    cached.every((c) => Date.now() - Date.parse(c.checkedAt) < 300000)
  )
    return cached;
  const fresh = await collectIndependent(m);
  await saveIndependentChecks(db(), m, fresh);
  return fresh;
}
export async function independentGet(request: Request) {
  try {
    await requireUser();
    const query = liveQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.id) throw new AuthError(400, "MARKET_REQUIRED");
    const page = livePageSchema.parse(await readLiveCatalog(query));
    const market = page.data.find(
      (m) => m.id === query.id && m.platform === query.platform,
    );
    if (!market) throw new AuthError(404, "MARKET_NOT_FOUND");
    const data = await loadIndependent({
      platform: market.platform,
      nativeId: market.id,
      eventId: market.eventId ?? null,
    });
    return Response.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof AuthError
            ? e.message
            : e instanceof z.ZodError
              ? "INVALID_INPUT"
              : "INDEPENDENT_SOURCES_UNAVAILABLE",
      },
      {
        status:
          e instanceof AuthError
            ? e.status
            : e instanceof z.ZodError
              ? 400
              : 503,
      },
    );
  }
}
