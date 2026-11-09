import "dotenv/config";
import { resolve } from "node:path";
import { Pool } from "pg";
import { scheduleResearchCohort } from "../packages/db/src/research-cohort";
import {
  researchFlags,
  pythonResearch,
  runTypedResearchJob,
} from "../packages/integrations/src/research-jobs";
import {
  researchSchedulerConfig,
  runResearchBatch,
} from "../packages/integrations/src/research-scheduler";
const flags = researchFlags(process.env);
const config = researchSchedulerConfig(process.env);
if (!process.env.DATABASE_URL || !process.env.RESEARCH_OWNER_ID)
  throw Error("RESEARCH_WORKER_CONFIG_REQUIRED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 15000,
  query_timeout: 20000,
  connectionTimeoutMillis: 10000,
  max: 2,
});
const ownerId = process.env.RESEARCH_OWNER_ID;
try {
  if (flags.RESEARCH_WORKER_ENABLED !== "true") {
    console.log(JSON.stringify({ disabled: true, checked: 0 }));
  } else {
    await pool.query(
      "INSERT INTO research_worker_health(user_id,last_started_at) VALUES($1,clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET last_started_at=clock_timestamp()",
      [ownerId],
    );
    const cohort = await scheduleResearchCohort(pool, ownerId);
    const result = await runResearchBatch({
      ...config,
      runOne: (remainingMs) =>
        runTypedResearchJob(pool, {
          ownerId,
          enabled: flags.RESEARCH_WORKER_ENABLED === "true",
          dailyQuota: config.dailyQuota,
          remainingMs,
          execute: (request, timeoutMs) =>
            pythonResearch({
              python: process.env.RESEARCH_PYTHON ?? "python",
              cwd: resolve("workers/research"),
              request,
              timeoutMs,
            }),
        }),
    });
    const summary = { ...result, cohort };
    await pool.query(
      "UPDATE research_worker_health SET last_success_at=clock_timestamp(),summary=$2 WHERE user_id=$1",
      [ownerId, summary],
    );
    console.log(JSON.stringify(summary));
  }
} catch (error) {
  await pool
    .query(
      "INSERT INTO research_worker_health(user_id,last_failed_at,summary) VALUES($1,clock_timestamp(),$2) ON CONFLICT(user_id) DO UPDATE SET last_failed_at=clock_timestamp(),summary=$2",
      [ownerId, { error: "RESEARCH_WORKER_FAILED" }],
    )
    .catch(() => {});
  const value =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNCLASSIFIED";
  const errorCode = /^[A-Z0-9_]{1,64}$/.test(value) ? value : "UNCLASSIFIED";
  console.error(JSON.stringify({ error: "RESEARCH_WORKER_FAILED", errorCode }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
