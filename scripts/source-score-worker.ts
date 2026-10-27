import "dotenv/config";
import { Pool } from "pg";
import { refreshOneSourceMarket } from "../packages/integrations/src/source-score-worker";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  for (let i = 0; i < (process.argv.includes("--batch") ? 3 : 1); i++) {
    try {
      const result = await refreshOneSourceMarket(pool);
      console.log(JSON.stringify({ check: "source.result", ...result }));
      if (!result.checked) break;
    } catch {
      console.error(
        JSON.stringify({ check: "source.result", status: "unavailable" }),
      );
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await pool.end();
}
