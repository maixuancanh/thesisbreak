import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listLessons, updateReviewedLesson } from "../packages/db/src/lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { recallApprovedContext } from "../packages/agent/src/approved-recall";
import { rememberedConditions } from "../packages/agent/src/remembered-conditions";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../packages/db/src/memory-outbox";
import { processMemoryClaim } from "../packages/integrations/src/memory-sync";
config({ path: ".local/production-runtime.env", override: true, quiet: true });
const dir = resolve(".local/learning-g1-g3-2026-10-30T11-47-47-750Z");
const prior = JSON.parse(await readFile(resolve(dir, "report.json"), "utf8"));
const tag = new Date().toISOString().replace(/[:.]/g, "-");
const save = (f: string, v: unknown) =>
  writeFile(
    resolve(dir, `${tag}-pause-${f}.json`),
    JSON.stringify(v, null, 2) + "\n",
    { flag: "wx" },
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new MemwalAdapter(
  officialMemwalClient(parseMemwalConfig(process.env)),
  prior.userId,
);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  ownerId: prior.userId,
  lessonId: prior.approval.lessonId,
  purpose:
    "Authorized isolated test pause/resume; no new distinct lesson or pick",
};
let paused = false;
try {
  const load = async () =>
    (await listLessons(pool, prior.userId)).map((x) => x.lesson);
  const before = (await load()).find((l) => l.id === prior.approval.lessonId);
  if (!before || before.status !== "active")
    throw Error("CURRENT_ACTIVE_TEST_LESSON_REQUIRED");
  const cached = await adapter.recall(before.rule);
  await save("remote-before", cached);
  const pause = await updateReviewedLesson(pool, prior.userId, before.id, {
    requestId: randomUUID(),
    baseVersion: before.version,
    action: "paused",
    confirmed: true,
  });
  paused = true;
  await save("transaction", pause);
  const current = await load();
  const recalled = await recallApprovedContext({
    userId: prior.userId,
    domain: "Sports",
    eventId: "KXNBAGAME-26OCT30CHAWAS",
    query: before.rule,
    now: new Date(),
    loadCurrent: async () => current,
    recall: async () => cached,
  });
  const policy = rememberedConditions({
    userId: prior.userId,
    domain: "Sports",
    eventId: "KXNBAGAME-26OCT30CHAWAS",
    now: new Date(),
    lessons: recalled,
  });
  await save("same-session-cached-readback-fence", {
    current,
    recalled,
    policy,
  });
  report.pausedExcluded =
    !recalled.some((l) => l.id === before.id) &&
    !policy.applied.some((l) => l.id === before.id);
  const pausedLesson = current.find((l) => l.id === before.id)!;
  const resume = await updateReviewedLesson(pool, prior.userId, before.id, {
    requestId: randomUUID(),
    baseVersion: pausedLesson.version,
    action: "active",
    confirmed: true,
    memoryConsent: true,
  });
  paused = false;
  await save("resume", resume);
  const sync = [];
  for (let i = 0; i < 4; i++) {
    const claim = await claimMemoryOutbox(pool, 150000, prior.userId);
    if (!claim) break;
    const result = await processMemoryClaim(claim, adapter, 120000);
    const saved = await finishMemoryOutbox(pool, claim, result);
    sync.push({ claim, result, saved });
    if (result.status !== "verified") break;
  }
  await save("resume-mainnet", sync);
  const readback = await recallApprovedContext({
    userId: prior.userId,
    domain: "Sports",
    eventId: "KXNBAGAME-26OCT30CHAWAS",
    query: before.rule,
    now: new Date(),
    loadCurrent: load,
    recall: async (q) => {
      const remote = await adapter.recall(q);
      await save(`resume-readback-${randomUUID()}`, remote);
      return remote;
    },
  });
  await save("resumed-current-recall", readback);
  report.resumedVersion = readback.find((l) => l.id === before.id)?.version;
  report.restoredExactCurrentVersion = readback.some(
    (l) => l.id === before.id && l.version === before.version + 2,
  );
  report.status =
    report.pausedExcluded && report.restoredExactCurrentVersion
      ? "PAUSE_RESUME_AUTHORITY_VERIFIED"
      : "incomplete";
} catch (e) {
  report.status = "incomplete";
  report.error = e instanceof Error ? e.message : "UNKNOWN";
  report.pausedLeftActive = paused;
} finally {
  adapter.destroy();
  await pool.end();
  report.completedAt = new Date().toISOString();
  await save("report", report);
  console.log(JSON.stringify(report));
}
