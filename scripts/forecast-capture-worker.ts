import "dotenv/config";
import { Pool } from "pg";
import { runForecastTick } from "../packages/integrations/src/forecast-tick";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(
    JSON.stringify({
      check: "nba.scheduled.capture",
      ...(await runForecastTick(pool)),
    }),
  );
} catch {
  console.error("NBA_CAPTURE_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await pool.end();
}
