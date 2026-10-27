import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, AuthError } from "./auth";
import {
  readResearchBriefing,
  readHabitReview,
} from "../../../../packages/db/src/research-memory";
import { briefingQuerySchema } from "../../../../packages/domain/src/research-memory";
import { readLiveCatalog } from "./live-catalog";
let pool: Pool | undefined;
function database() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function researchMemoryOperation(
  request: Request,
  operation: "briefing" | "habits",
) {
  try {
    const user = await requireUser();
    if (operation === "habits")
      return json(await readHabitReview(database(), user.id));
    const url = new URL(request.url);
    const query = briefingQuerySchema.parse(
      Object.fromEntries(url.searchParams),
    );
    let scope: { domain: string; competition?: string } | undefined;
    try {
      const raw = await readLiveCatalog({ ...query, limit: 1 });
      const parsed = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              platform: z.string(),
              category: z.string().nullable().optional(),
              competition: z.string().nullable().optional(),
            }),
          ),
        })
        .safeParse(raw);
      const market = parsed.success
        ? parsed.data.data.find(
            (m) => m.id === query.id && m.platform === query.platform,
          )
        : undefined;
      if (market)
        scope = {
          domain: market.category ?? "unclassified",
          ...(market.competition ? { competition: market.competition } : {}),
        };
    } catch {
      /* Recorded owned context remains available. No stale scope is treated as current. */
    }
    const briefing = await readResearchBriefing(
      database(),
      user.id,
      query,
      scope,
    );
    return json({ ...briefing, contextStatus: scope ? "live" : "recorded" });
  } catch (error) {
    if (error instanceof AuthError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: "INVALID_INPUT" }, 400);
    return json({ error: "MEMORY_UNAVAILABLE" }, 503);
  }
}
