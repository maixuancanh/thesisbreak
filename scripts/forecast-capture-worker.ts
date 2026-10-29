import "dotenv/config";
import { Pool } from "pg";
import { captureDueForecasts } from "../packages/integrations/src/forecast-scheduler";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(
    JSON.stringify({
      check: "nba.scheduled.capture",
      ...(await captureDueForecasts(pool)),
    }),
  );
} catch {
  console.error("NBA_CAPTURE_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await pool.end();
}
