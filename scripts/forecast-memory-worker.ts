import "dotenv/config";
import { Pool } from "pg";
import { syncNbaForecastMemory } from "../packages/db/src/forecast-ledger";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
if (!process.argv.includes("--enable-remote-writes"))
  throw Error("Explicit --enable-remote-writes required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  // Live-only queue: replay is never synchronized by a production worker.
  const pending = (
    await pool.query(
      `SELECT f.id,f.user_id FROM nba_forecasts f LEFT JOIN LATERAL (SELECT revision FROM nba_forecast_results WHERE user_id=f.user_id AND namespace=f.namespace AND event_id=f.event_id ORDER BY revision DESC LIMIT 1) r ON true WHERE f.namespace='live' AND f.memory_consent=true AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions sub WHERE sub.user_id=f.user_id AND sub.memory_consent=false) AND NOT EXISTS(SELECT 1 FROM nba_forecast_memory_receipts m WHERE m.forecast_id=f.id AND m.version=COALESCE(r.revision+1,1)) ORDER BY f.captured_at LIMIT 3`,
    )
  ).rows;
  for (const row of pending) {
    const adapter = new MemwalAdapter(
      officialMemwalClient(parseMemwalConfig(process.env)),
      row.user_id,
    );
    try {
      const result = await syncNbaForecastMemory(
        pool,
        adapter,
        row.user_id,
        row.id,
      );
      console.log(
        JSON.stringify({ check: "nba.memory", status: result.status }),
      );
    } finally {
      adapter.destroy();
    }
  }
  console.log(
    JSON.stringify({ check: "nba.memory.batch", checked: pending.length }),
  );
} finally {
  await pool.end();
}
