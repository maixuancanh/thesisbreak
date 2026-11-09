import { Pool } from "pg";
import { authorizeForecastTick } from "../../../../../../packages/integrations/src/forecast-tick";
import { runForecastMaintenance } from "../../../../../../packages/integrations/src/forecast-maintenance";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
let pool: Pool | undefined;
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (
    !authorizeForecastTick(
      request.headers.get("authorization"),
      process.env.FORECAST_CRON_SECRET,
    )
  )
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  try {
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      allowExitOnIdle: true,
    });
    return Response.json(await runForecastMaintenance(pool), { headers });
  } catch {
    return Response.json(
      { error: "FORECAST_MAINTENANCE_FAILED" },
      { status: 503, headers },
    );
  }
}
