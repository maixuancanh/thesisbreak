/** Uses only the existing labelled acceptance lesson, never a user's real preference. */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listLessons, updateReviewedLesson } from "../packages/db/src/lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { recallApprovedContext } from "../packages/agent/src/approved-recall";
if (!process.argv.includes("--resume-acceptance"))
  throw new Error(
    "Explicit --resume-acceptance required: writes a new version of the existing acceptance lesson",
  );
const state = JSON.parse(readFileSync(".local/memory-journey.json", "utf8"));
if (
  typeof state.userId !== "string" ||
  !state.userId.startsWith("thesisbreak-acceptance-")
)
  throw new Error("ACCEPTANCE_OWNER_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
try {
  const current = (await listLessons(pool, state.userId)).find(
    (l) => l.lesson.id === state.lessonId,
  )?.lesson;
  if (!current) throw new Error("LESSON_MISSING");
  if (current.status !== "active") throw new Error("EXPECTED_ACTIVE_LESSON");
  const paused = await updateReviewedLesson(pool, state.userId, current.id, {
    requestId: randomUUID(),
    baseVersion: current.version,
    action: "paused",
    confirmed: true,
  });
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    state.userId,
  );
  const context = {
    query: current.rule,
    userId: state.userId,
    domain: current.scope.domain,
    now: new Date(),
    loadCurrent: async () =>
      (await listLessons(pool, state.userId)).map((l) => l.lesson),
    recall: (q: string) => adapter!.recall(q),
  };
  const excluded = await recallApprovedContext(context);
  if (excluded.length) throw new Error("PAUSED_MEMORY_LEAK");
  const resumed = await updateReviewedLesson(pool, state.userId, current.id, {
    requestId: randomUUID(),
    baseVersion: paused.version,
    action: "active",
    confirmed: true,
    memoryConsent: true,
  });
  let verified = false;
  for (let i = 0; i < 60; i++) {
    const row = (await listLessons(pool, state.userId)).find(
      (l) => l.lesson.id === current.id,
    );
    if (row?.lesson.version === resumed.version && row.sync.state === "done") {
      verified = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!verified) throw new Error("RESUME_SYNC_PENDING");
  const recalled = await recallApprovedContext({ ...context, now: new Date() });
  if (
    !recalled.some((l) => l.id === current.id && l.version === resumed.version)
  )
    throw new Error("RESUMED_MEMORY_MISSING");
  const proof = {
    checkedAt: new Date().toISOString(),
    pausedExcluded: true,
    resumedVersion: resumed.version,
    resumedRemoteVerified: true,
    logicalLessonsAdded: 0,
    label:
      "Lifecycle of existing acceptance lesson only; versions do not count as additional distinct memories",
  };
  writeFileSync(
    ".local/memory-lifecycle-proof.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
} catch (e) {
  console.log(
    JSON.stringify({
      check: "memory.lifecycle",
      status: "failed",
      code:
        e instanceof Error && /^[A-Z_]+$/.test(e.message)
          ? e.message
          : "LIFECYCLE_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  adapter?.destroy();
  await pool.end();
}
