import "dotenv/config";
import { Pool } from "pg";
import { refreshNbaForecastResults } from "../packages/integrations/src/forecast-results";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(
    JSON.stringify({
      check: "nba.official.results",
      ...(await refreshNbaForecastResults(pool)),
    }),
  );
} catch {
  console.error("NBA_RESULT_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await pool.end();
}
