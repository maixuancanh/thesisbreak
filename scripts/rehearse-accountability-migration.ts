import "dotenv/config";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
const u = new URL(process.env.TEST_DATABASE_URL!);
if (u.hostname !== "127.0.0.1" || u.pathname !== "/thesisbreak_test")
  throw Error("ISOLATION_REQUIRED");
const admin = new Pool({ connectionString: u.href });
const name = "thesisbreak_accountability_v2_20261103";
if (
  !(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
    .rowCount
)
  await admin.query(`CREATE DATABASE ${name}`);
u.pathname = "/" + name;
const p = new Pool({ connectionString: u.href });
try {
  await migrate(drizzle(p), { migrationsFolder: "packages/db/migrations" });
  const first = await p.query(
    "SELECT count(*) FROM drizzle.__drizzle_migrations",
  );
  const sentinel="accountability-migration-replay-sentinel";
  await p.query("INSERT INTO users(id,provider_subject) VALUES($1,$1) ON CONFLICT DO NOTHING",[sentinel]);
  const before=(await p.query("SELECT row_to_json(u) AS payload FROM users u WHERE id=$1",[sentinel])).rows[0].payload;
  await migrate(drizzle(p), { migrationsFolder: "packages/db/migrations" });
  const after=(await p.query("SELECT row_to_json(u) AS payload FROM users u WHERE id=$1",[sentinel])).rows[0].payload;
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error("MIGRATION_REPLAY_CHANGED_DATA");
  await p.query("DELETE FROM users WHERE id=$1",[sentinel]);
  const second = await p.query(
    "SELECT count(*) FROM drizzle.__drizzle_migrations",
  );
  console.log(
    JSON.stringify({
      database: name,
      first: first.rows[0].count,
      second: second.rows[0].count,
      sentinelUnchanged:true,
      checksum: (await import("node:crypto"))
        .createHash("sha256")
        .update(
          readFileSync("packages/db/migrations/0038_review_accountability.sql"),
        )
        .digest("hex"),
    }),
  );
} finally {
  await p.end();
  await admin.end();
}
