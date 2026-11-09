import { Pool } from "pg";
import {
  authorizeForecastTick,
  runForecastTick,
} from "../../../../../../packages/integrations/src/forecast-tick";
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
      allowExitOnIdle: true,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    });
    await pool.query(
      "INSERT INTO forecast_worker_health(job,last_started_at) VALUES('nba.capture.cloudflare',clock_timestamp()) ON CONFLICT(job) DO UPDATE SET last_started_at=clock_timestamp()",
    );
    const result = await runForecastTick(pool);
    if (result.status === "ok")
      await pool.query(
        "UPDATE forecast_worker_health SET last_success_at=clock_timestamp(),summary=$1 WHERE job='nba.capture.cloudflare'",
        [JSON.stringify(result)],
      );
    return Response.json(result, { headers });
  } catch {
    return Response.json(
      { error: "FORECAST_TICK_FAILED" },
      { status: 503, headers },
    );
  }
}
