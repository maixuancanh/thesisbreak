import { Pool } from "pg";
import { authorizeForecastTick } from "../../../../../../packages/integrations/src/forecast-tick";
import { runSourceWatchBatch } from "../../../../../../packages/integrations/src/source-watch";
import { sourceWatchConfig } from "../../../../../../packages/integrations/src/source-watch-config";
export const runtime = "nodejs";
export const maxDuration = 60;
let pool: Pool | undefined;
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (
    !authorizeForecastTick(
      request.headers.get("authorization"),
      process.env.SOURCE_WATCH_CRON_SECRET,
    )
  )
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  const config = sourceWatchConfig();
  if (!config.enabled)
    return Response.json({ status: "disabled" }, { headers });
  try {
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      allowExitOnIdle: true,
    });
    return Response.json(
      { results: await runSourceWatchBatch(pool, config, 1) },
      { headers },
    );
  } catch {
    return Response.json(
      { error: "SOURCE_WATCH_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
