import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL === process.env.DATABASE_URL
)
  throw new Error("A separate TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
try {
  await migrate(drizzle(pool), { migrationsFolder: "packages/db/migrations" });
  console.log("Isolated test database migrated");
} finally {
  await pool.end();
}
