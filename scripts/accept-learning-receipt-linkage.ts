import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { createChatSession } from "../packages/db/src/chat-sessions";
import { claimRun, finishRun } from "../packages/db/src/agent-runs";
import { runResearch } from "../packages/agent/src/runtime";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";
import { recallApprovedContext } from "../packages/agent/src/approved-recall";
import { listLessons } from "../packages/db/src/lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { runOneReceiptPreparation } from "../packages/integrations/src/run-receipt-worker";
import { runOneReceiptPublication } from "../packages/integrations/src/receipt-publication-worker";
import { runOneEventDossierJob } from "../packages/integrations/src/event-dossier-worker";
import { publicDecisionReceipt } from "../packages/domain/src/decision-receipt";
config({ path: ".local/production-runtime.env", override: true, quiet: true });
const dir = resolve(".local/learning-g1-g3-2026-10-30T11-47-47-750Z");
const previous = JSON.parse(
  await readFile(resolve(dir, "report.json"), "utf8"),
);
const snapshot = JSON.parse(
  await readFile(
    ".local/learning-action-pair-2026-10-30T08-29-55-990Z/provider-snapshot.json",
    "utf8",
  ),
);
const tag = new Date().toISOString().replace(/[:.]/g, "-");
const save = (f: string, v: unknown) =>
  writeFile(
    resolve(dir, `${tag}-run-c-${f}.json`),
    JSON.stringify(v, null, 2) + "\n",
    { flag: "wx" },
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  execution:
    "direct runtime + production DB + Mainnet, no authenticated HTTP/UI",
  ownerId: previous.userId,
  pickChanges: 0,
};
const raw: unknown[] = [];
try {
  const m = snapshot.market;
  const market = {
    platform: m.platform,
    nativeId: m.id,
    question: [m.eventTitle, m.question]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 2000),
    outcomes: m.outcomes.map((o: { name: string }) => o.name),
    rules: m.rules,
  };
  const session = await createChatSession(pool, previous.userId, true);
  const message =
    "Isolated workflow acceptance continuation: recall my approved procedure and check whether reconsidering a pick must wait. Do not save or transact a pick. This is not a forecast.";
  const run = await claimRun(pool, previous.userId, {
    sessionId: session.id,
    platform: m.platform,
    nativeId: m.id,
    provider: "public",
    message,
    requestId: randomUUID(),
  });
  report.runId = run.id;
  report.sessionId = session.id;
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    previous.userId,
  );
  let proofs: { id: string; version: number; hash: string }[] = [];
  const readLessons = async () => {
    proofs = [];
    const lessons = await recallApprovedContext({
      userId: previous.userId,
      domain: "Sports",
      eventId: m.eventId,
      now: new Date(),
      query: message,
      loadCurrent: async () =>
        (await listLessons(pool, previous.userId)).map((x) => x.lesson),
      recall: async (q) => {
        const remote = await adapter!.recall(q);
        raw.push({ stage: "sdk_readback", remote });
        for (const r of remote.records)
          if (r.type === "lesson")
            proofs.push({ id: r.logicalId, version: r.version, hash: r.hash });
        return remote;
      },
    });
    return lessons;
  };
  const plan = createOfficialPlanner(process.env),
    generate = createOfficialGenerator(process.env);
  const result = await runResearch(
    {
      userId: previous.userId,
      market,
      message,
      history: [],
      domain: "Sports",
      eventId: m.eventId,
      now: new Date(),
    },
    {
      plan: async (input) => {
        const output = await plan(input);
        raw.push({ stage: "planner", input, output });
        return output;
      },
      generate: async (input) => {
        const output = await generate(input);
        raw.push({ stage: "generator", input, output });
        return output;
      },
      readLessons,
      readLessonProofs: () => [
        ...new Map(proofs.map((p) => [`${p.id}:${p.version}`, p])).values(),
      ],
      readPick: async () => null,
      readComparison: async () => [],
      readIndependent: async () => structuredClone(snapshot.independent),
      marketSource: {
        id: "market-source",
        url: m.sourceUrl,
        text: JSON.stringify(m).slice(0, 9500),
        retrievedAt: m.fetchedAt,
        kind: "market",
      },
    },
  );
  await save("runtime", { raw, result });
  if (
    !result.verifiedLearningMemories.some(
      (p) => p.id === previous.approval.lessonId,
    )
  )
    throw Error("ACTUAL_APPROVED_LESSON_HASH_MISSING");
  await finishRun(
    pool,
    previous.userId,
    run.id,
    {
      ...result,
      modelVersion: parseLlmConfig(process.env).model,
      promptVersion: "authorized-isolated-learning-run-c-v1",
    },
    "completed",
  );
  const steps = [];
  for (let i = 0; i < 4; i++) {
    const prepare = await runOneReceiptPreparation(pool, previous.userId);
    const dossier = await runOneEventDossierJob(pool, previous.userId);
    steps.push({ prepare, dossier });
    if (!prepare.checked && !dossier.checked) break;
  }
  await save("prepare", steps);
  for (let i = 0; i < 4; i++) {
    const p = await runOneReceiptPublication(
      pool,
      (owner) =>
        new MemwalAdapter(
          officialMemwalClient(parseMemwalConfig(process.env)),
          owner,
        ),
      previous.userId,
    );
    await save(`publish-${i}`, p);
    if (!p.checked) break;
  }
  const receipt = (
    await pool.query(
      "SELECT * FROM decision_receipts WHERE user_id=$1 AND id=$2",
      [previous.userId, run.id],
    )
  ).rows[0];
  await save("persisted-receipt", receipt);
  if (!receipt) throw Error("RECEIPT_MISSING");
  adapter.destroy();
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    previous.userId,
  );
  const remote = await adapter.recall(`decision-receipt:${run.id}`);
  await save("fresh-receipt-readback", remote);
  const exact = remote.sources.find(
    (s) =>
      s.record.logicalId === `decision-receipt:${run.id}` &&
      s.record.version === 1 &&
      s.record.hash === receipt.readback_hash &&
      s.blobId === receipt.record_id &&
      isDeepStrictEqual(
        s.record.payload,
        publicDecisionReceipt(receipt.payload),
      ),
  );
  report.receiptExactVerified = !!exact;
  report.recordId = receipt.record_id;
  report.hash = receipt.readback_hash;
  report.receiptMemories = receipt.payload.memories;
  report.actualMemories = result.verifiedLearningMemories;
  report.memoryHashLinkage = receipt.payload.memories.some(
    (p: { id: string; version: number; hash: string }) =>
      p.id === previous.approval.lessonId &&
      result.verifiedLearningMemories.some((x) => isDeepStrictEqual(x, p)),
  );
  report.policy = result.policyRequiredTools;
  report.gate = result.learningGate;
  report.status =
    report.receiptExactVerified && report.memoryHashLinkage
      ? "EXACT_RECEIPT_MEMORY_LINKAGE_VERIFIED"
      : "INCOMPLETE";
} catch (e) {
  report.status = "incomplete";
  report.error = e instanceof Error ? e.message : "UNKNOWN";
} finally {
  adapter?.destroy();
  await pool.end();
  report.completedAt = new Date().toISOString();
  await save("report", report);
  console.log(JSON.stringify(report));
}
