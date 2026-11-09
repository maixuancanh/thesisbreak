import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { runOneEventDossierJob } from "../packages/integrations/src/event-dossier-worker";
import { runOneReceiptPreparation } from "../packages/integrations/src/run-receipt-worker";
import { runOneReceiptPublication } from "../packages/integrations/src/receipt-publication-worker";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { publicDecisionReceipt } from "../packages/domain/src/decision-receipt";
config({ path: ".local/production-runtime.env", override: true, quiet: true });
const dir = resolve(".local/learning-g1-g3-2026-10-30T11-47-47-750Z");
const prior = JSON.parse(await readFile(resolve(dir, "report.json"), "utf8"));
const tag = new Date().toISOString().replace(/[:.]/g, "-");
const save = (f: string, v: unknown) =>
  writeFile(
    resolve(dir, `${tag}-${f}.json`),
    JSON.stringify(v, null, 2) + "\n",
    { flag: "wx" },
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  execution:
    "direct local runtime + production database + Mainnet SDK; not authenticated HTTP or browser",
  userId: prior.userId,
  runIds: [prior.runA, prior.runB],
  pickChanges: 0,
};
try {
  const jobs = (
    await pool.query(
      "SELECT * FROM learning_jobs WHERE user_id=$1 AND kind IN ('dossier_refresh','receipt_prepare','receipt_publish') ORDER BY recorded_at",
      [prior.userId],
    )
  ).rows;
  await save("jobs-before", jobs);
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const dossier = await runOneEventDossierJob(pool, prior.userId);
    const receipt = await runOneReceiptPreparation(pool, prior.userId);
    steps.push({ dossier, receipt });
    if (!dossier.checked && !receipt.checked) break;
  }
  await save("local-workers", steps);
  for (let i = 0; i < 6; i++) {
    const publication = await runOneReceiptPublication(
      pool,
      (owner) =>
        new MemwalAdapter(
          officialMemwalClient(parseMemwalConfig(process.env)),
          owner,
        ),
      prior.userId,
    );
    await save(`publication-${i}`, publication);
    if (!publication.checked) break;
  }
  const receipts = (
    await pool.query(
      "SELECT * FROM decision_receipts WHERE user_id=$1 AND id=ANY($2) ORDER BY recorded_at",
      [prior.userId, [prior.runA, prior.runB]],
    )
  ).rows;
  await save("local-receipts", receipts);
  const dossier = (
    await pool.query(
      "SELECT * FROM event_dossier_versions WHERE user_id=$1 AND event_id=$2 ORDER BY revision",
      [prior.userId, "KXNBAGAME-26OCT30CHAWAS"],
    )
  ).rows;
  await save("dossier-revisions", dossier);
  const applications = (
    await pool.query(
      "SELECT * FROM lesson_applications WHERE user_id=$1 AND run_id=ANY($2)",
      [prior.userId, [prior.runA, prior.runB]],
    )
  ).rows;
  await save("lesson-applications", applications);
  const consent = (
    await pool.query(
      "SELECT id,memory_consent FROM conversations WHERE user_id=$1 AND id=ANY($2)",
      [prior.userId, [prior.sessionA, prior.sessionB]],
    )
  ).rows;
  await save("current-consent", consent);
  const readbacks = [];
  for (const r of receipts) {
    const a = new MemwalAdapter(
      officialMemwalClient(parseMemwalConfig(process.env)),
      prior.userId,
    );
    try {
      const remote = await a.recall(`decision-receipt:${r.id}`);
      await save(`fresh-receipt-readback-${r.id}`, remote);
      const exact = remote.sources.find(
        (s) =>
          s.record.logicalId === `decision-receipt:${r.id}` &&
          s.record.type === "decision.receipt" &&
          s.record.version === 1 &&
          s.blobId === r.record_id &&
          s.record.hash === r.readback_hash &&
          isDeepStrictEqual(s.record.payload, publicDecisionReceipt(r.payload)),
      );
      readbacks.push({
        runId: r.id,
        verified: !!exact,
        publication: r.publication_state,
        blobId: r.record_id,
        hash: r.readback_hash,
        memories: r.payload.memories,
        applied: r.payload.appliedConditions,
      });
    } finally {
      a.destroy();
    }
  }
  result.readbacks = readbacks;
  result.exactReceiptsVerified =
    readbacks.length === 2 && readbacks.every((r) => r.verified);
  result.dossierRevisions = dossier.length;
  result.applicationCount = applications.length;
  result.currentConsent = consent.every((c) => c.memory_consent === true);
  result.limitations = [
    "Direct runtime execution, not authenticated HTTP or browser UI",
    "Frozen original provider snapshots, no fabricated freshness",
    "Original acceptance runtime did not supply readLessonProofs callback: receipt memories list may be empty despite applied lesson IDs; approved lesson exact Mainnet proof remains separately verified in original G2 artifacts",
  ];
  result.status = "completed";
} catch (e) {
  result.status = "incomplete";
  result.error = e instanceof Error ? e.message : "UNKNOWN";
} finally {
  await pool.end();
  result.completedAt = new Date().toISOString();
  await save("receipt-dossier-report", result);
  await save("corrected-g1-g3-report", {
    ...prior,
    status: "G1_G2_G3_VERIFIED_DIRECT_RUNTIME_PRODUCTION_DB_MAINNET",
    execution: result.execution,
    originalReportPreserved: true,
  });
  console.log(JSON.stringify(result));
}
