import "dotenv/config";
import { Pool } from "pg";
import { runAutomaticForecastChallenger } from "../packages/integrations/src/forecast-challenger-worker";
if (!process.env.DATABASE_URL) throw Error("DATABASE_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  console.log(JSON.stringify(await runAutomaticForecastChallenger(pool)));
} finally {
  await pool.end();
}
