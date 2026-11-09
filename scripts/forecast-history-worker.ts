import "dotenv/config";
import { Pool } from "pg";
import { refreshNbaHistory } from "../packages/integrations/src/forecast-observations";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const end = new Date(),
    start = new Date(
      end.getTime() -
        (process.argv.includes("--bootstrap") ? 9 : 1) * 86400000,
    );
  console.log(
    JSON.stringify({
      check: "nba.history",
      ...(await refreshNbaHistory(
        pool,
        start.toISOString().slice(0, 10),
        end.toISOString().slice(0, 10),
      )),
    }),
  );
} catch {
  console.error("NBA_HISTORY_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await pool.end();
}

