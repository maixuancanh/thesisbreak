import "server-only";
import { Pool } from "pg";
import { readPortfolioReasons } from "../../../../packages/db/src/portfolio-reasons";
import { requireUser, AuthError } from "./auth";

let pool: Pool | undefined;
export async function portfolioConnections() {
  try {
    const user = await requireUser();
    if (!process.env.DATABASE_URL) throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
    pool ??= new Pool({ connectionString: process.env.DATABASE_URL, allowExitOnIdle: true });
    return Response.json(await readPortfolioReasons(pool, user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof AuthError ? error.message : "CONNECTIONS_UNAVAILABLE" }, {
      status: error instanceof AuthError ? error.status : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
