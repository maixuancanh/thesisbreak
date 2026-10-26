import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
export function createDatabase(url: string) {
  if (!url) throw new Error("DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: url });
  return { pool, db: drizzle(pool, { schema }) };
}
