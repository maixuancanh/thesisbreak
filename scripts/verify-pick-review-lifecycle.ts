import { TatumSuiGrpcProof } from "../packages/integrations/src/tatum/sui-grpc-proof";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { loadResearchArtifactMemory } from "../packages/db/src/research-artifact-memory";
import {
  runResearchArtifactMemoryOnce,
  recallResearchArtifactForPlanning,
} from "../packages/integrations/src/research-artifact-memory";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
const args = process.argv.slice(2),
  mainnet = args.includes("--mainnet"),
  requestPath = args.find((v) => !v.startsWith("--"));
const reportDirectory = resolve(".local/pick-review-acceptance");
await mkdir(reportDirectory, { recursive: true });
const report: Record<string, unknown> = {
  mode: mainnet ? "acceptance_test" : "dry_run",
  publication: "not_run",
  freshRead: "not_run",
  runtimeUse: "not_run",
  tatumProof: "not_run",
  eventTruth: "not_inferred_from_storage",
  recordedAt: new Date().toISOString(),
};
let pool: Pool | undefined;
try {
  if (!requestPath) {
    report.status = "dry_run_no_request";
  } else {
    const request = z
      .object({ ownerId: z.string().min(1), publicationId: z.string().min(1) })
      .strict()
      .parse(JSON.parse(await readFile(requestPath, "utf8")));
    if (!process.env.DATABASE_URL) throw Error("DATABASE_NOT_CONFIGURED");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const identity = {
      id: request.publicationId,
      ownerId: request.ownerId,
      reviewerId: request.ownerId,
    };
    const claim = await loadResearchArtifactMemory(pool, identity);
    if (
      claim.kind !== "decision_recap" ||
      claim.record.payload === null ||
      typeof claim.record.payload !== "object" ||
      Array.isArray(claim.record.payload) ||
      claim.record.payload.mode !== "acceptance_test"
    )
      throw Error("CONSENTED_ACCEPTANCE_RECAP_REQUIRED");
    report.status = "owner_and_current_grant_checked";
    if (mainnet) {
      if (process.env.RESEARCH_ARTIFACT_MEMORY_ENABLED !== "true")
        throw Error("RESEARCH_ARTIFACT_MEMORY_DISABLED");
      const createAdapter = () =>
        new MemwalAdapter(
          officialMemwalClient(parseMemwalConfig(process.env)),
          request.ownerId,
        );
      report.publication = await runResearchArtifactMemoryOnce(pool, {
        ...identity,
        enabled: true,
        createAdapter,
      });
      const fresh = await recallResearchArtifactForPlanning(pool, {
        ...identity,
        createAdapter,
      });
      report.freshRead = {
        status: fresh.status,
        checks: fresh.checks,
        evidence: fresh.evidence,
      };
      report.runtimeUse =
        fresh.status === "verified"
          ? "planning_checks_verified_full_chat_not_run"
          : "blocked_no_runtime_use";
      try {
        report.tatumProof = {
          status: "account_observed",
          proof: await new TatumSuiGrpcProof({
            apiKey: process.env.TATUM_API_KEY ?? "",
            accountId: process.env.MEMWAL_ACCOUNT_ID ?? "",
            owner: process.env.MEMWAL_OWNER_ADDRESS ?? "",
          }).verify(),
          recordInclusion: "not_verified",
          eventTruth: "not_assessed",
        };
      } catch {
        report.tatumProof = {
          status: "unavailable",
          recordInclusion: "not_verified",
          eventTruth: "not_assessed",
        };
      }
    }
  }
} catch {
  report.status = "blocked";
  report.error = "OWNER_CONSENT_ARTIFACT_OR_PROVIDER_CHECK_FAILED";
  process.exitCode = 1;
} finally {
  await pool?.end();
  const file = resolve(reportDirectory, `${Date.now()}-lifecycle.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ report: file, status: report.status, mode: report.mode }),
  );
}
