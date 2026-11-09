import { Pool } from "pg";
import { deploymentReadiness } from "../../../../../packages/domain/src/deployment-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let pool: Pool | undefined;
export async function GET() {
  const result = await deploymentReadiness(process.env, async () => {
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      allowExitOnIdle: true,
    });
    // Readiness requires the account schema as well as a database connection.
    await pool.query("SELECT id FROM users LIMIT 0");
  });
  return Response.json(result, {
    status: result.status === "ready" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
