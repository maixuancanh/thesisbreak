import "dotenv/config";
import { Pool } from "pg";
import { readMemoryInventory } from "../packages/db/src/memory-recovery";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle: true,
});
try {
  if (!process.env.DATABASE_URL) throw new Error("unconfigured");
  const users = await pool.query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM outbox WHERE kind='lesson.version.created' AND payload->'memoryConsent'='true'::jsonb",
  );
  let records = 0,
    lessons = 0,
    rejected = 0,
    truncated = false;
  for (const { user_id } of users.rows) {
    const { summary } = await readMemoryInventory(pool, user_id);
    records += summary.expectedRecords;
    lessons += summary.verifiedDistinctLessons;
    rejected += summary.rejectedRecords;
    truncated ||= summary.truncated;
  }
  console.log(
    JSON.stringify({
      source: "database_receipts_only",
      owners: users.rowCount,
      expectedRecords: records,
      verifiedDistinctLessons: lessons,
      rejectedRecords: rejected,
      truncated,
      remoteCompleteness: "unverified",
    }),
  );
} catch {
  console.error("AUDIT_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await pool.end();
}
