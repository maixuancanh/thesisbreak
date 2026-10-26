import "dotenv/config";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client";
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("BLOCKED: DATABASE_URL required; no migration applied");
const { pool, db } = createDatabase(url);
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  console.log("Migrations applied");
} finally {
  await pool.end();
}
