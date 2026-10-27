import { Pool } from "pg";
import { z } from "zod";
import { requireUser, AuthError } from "../../../../lib/server/auth";
import { readTatumOperation } from "../../../../lib/server/tatum-service";
import { CatalogError } from "../../../../../../packages/integrations/src/tatum/catalog";
import { ProviderBudgetError } from "../../../../../../packages/db/src/provider-budget";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let pool: Pool | undefined;
export async function GET(request: Request) {
  try {
    await requireUser();
    if (!process.env.DATABASE_URL)
      throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
    if (request.url.length > 6000) throw new AuthError(400, "INVALID_QUERY");
    const query: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      if (Object.hasOwn(query, key)) throw new AuthError(400, "INVALID_QUERY");
      query[key] = value;
    }
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    });
    return Response.json(await readTatumOperation(pool, query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const code =
      error instanceof AuthError
        ? error.message
        : error instanceof z.ZodError
          ? "INVALID_QUERY"
          : error instanceof CatalogError
            ? error.code
            : error instanceof ProviderBudgetError
              ? error.message
              : "RESEARCH_UNAVAILABLE";
    const status =
      error instanceof AuthError
        ? error.status
        : code === "INVALID_QUERY"
          ? 400
          : code === "MARKET_NOT_FOUND"
            ? 404
            : code.includes("RATE_LIMITED") || code.includes("BUDGET")
              ? 429
              : 503;
    return Response.json(
      { error: code },
      {
        status,
        headers: {
          "Cache-Control": "no-store",
          ...(error instanceof CatalogError && error.retryAfterSeconds
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {}),
        },
      },
    );
  }
}
