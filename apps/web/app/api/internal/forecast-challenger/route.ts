import { Pool } from "pg";
import { authorizeForecastTick } from "../../../../../../packages/integrations/src/forecast-tick";
import { runAutomaticForecastChallenger } from "../../../../../../packages/integrations/src/forecast-challenger-worker";
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
  if (
    process.env.FORECAST_CHALLENGER_ENABLED !== "true" ||
    process.env.FORECAST_CHALLENGER_MODE !== "shadow"
  )
    return Response.json({ status: "disabled" }, { headers });
  try {
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      allowExitOnIdle: true,
    });
    return Response.json(await runAutomaticForecastChallenger(pool), {
      headers,
    });
  } catch {
    return Response.json(
      { error: "FORECAST_CHALLENGER_FAILED" },
      { status: 503, headers },
    );
  }
}
