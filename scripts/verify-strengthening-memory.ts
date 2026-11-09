import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";
import {
  deriveResearchArtifact,
  enqueueResearchArtifactMemory,
} from "../packages/db/src/research-artifact-memory";
import { researchArtifactHash } from "../packages/domain/src/research-memory-version";
import {
  runResearchArtifactMemoryOnce,
  recallResearchArtifactForPlanning,
} from "../packages/integrations/src/research-artifact-memory";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
const identity = {
  evaluationOwnerId: z.string().min(1),
  reviewerId: z.string().min(1),
};
const artifact = {
  kind: z.enum([
    "source_change",
    "forecast_rationale",
    "forecast_result",
    "drift_summary",
  ]),
  artifactId: z.string().min(1),
};
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), ...identity, ...artifact }).strict(),
  z
    .object({
      action: z.literal("prepare"),
      ...identity,
      ...artifact,
      consentGrantId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.enum(["publish", "fresh-read"]),
      ...identity,
      publicationId: z.string().min(1),
    })
    .strict(),
]);
if (!process.argv[2]) throw Error("REQUEST_FILE_REQUIRED");
const request = requestSchema.parse(
  JSON.parse(await readFile(process.argv[2], "utf8")),
);
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
// Remote access needs an explicit operator switch; prepare and inspect never construct an SDK.
if (
  (request.action === "publish" || request.action === "fresh-read") &&
  process.env.RESEARCH_ARTIFACT_MEMORY_ENABLED !== "true"
)
  throw Error("RESEARCH_ARTIFACT_MEMORY_DISABLED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const ownerId = request.evaluationOwnerId,
    reviewerId = request.reviewerId;
  const operator = await pool.query(
    "SELECT user_id FROM procedure_reviewer_authorizations WHERE user_id=$1 AND revoked_at IS NULL",
    [reviewerId],
  );
  if (!operator.rowCount) throw Error("RESEARCH_ARTIFACT_OPERATOR_REQUIRED");
  if (request.action === "inspect") {
    const artifact = await deriveResearchArtifact(
      pool,
      ownerId,
      request.kind,
      request.artifactId,
    );
    console.log(
      JSON.stringify({
        kind: artifact.kind,
        artifactId: artifact.artifactId,
        snapshotHash: researchArtifactHash(artifact.snapshot),
        write: "not_run",
        receipt: "not_run",
        freshRead: "not_run",
        runtimeUse: "not_run",
      }),
    );
  } else if (request.action === "prepare") {
    const id = await enqueueResearchArtifactMemory(pool, {
      ownerId,
      reviewerId,
      grantId: request.consentGrantId,
      kind: request.kind,
      artifactId: request.artifactId,
    });
    console.log(
      JSON.stringify({
        publicationId: id,
        write: "not_run",
        receipt: "not_run",
        freshRead: "not_run",
        runtimeUse: "not_run",
      }),
    );
  } else {
    const input = {
      id: request.publicationId,
      ownerId,
      reviewerId,
      createAdapter: () =>
        new MemwalAdapter(
          officialMemwalClient(parseMemwalConfig(process.env)),
          ownerId,
        ),
    };
    if (request.action === "publish") {
      const result = await runResearchArtifactMemoryOnce(pool, {
        ...input,
        enabled: true,
      });
      console.log(
        JSON.stringify({
          publicationId: input.id,
          writeAndReceipt: result.verified === 1 ? "verified" : "unverified",
          freshRead: "not_run",
          runtimeUse: "not_run",
        }),
      );
      if (result.verified !== 1) process.exitCode = 1;
    } else {
      const result = await recallResearchArtifactForPlanning(pool, input);
      console.log(
        JSON.stringify({
          publicationId: input.id,
          writeAndReceipt: "recorded",
          freshRead: result.status,
          runtimeUse: "not_run",
          planningCheckEvidence: result.evidence,
        }),
      );
      if (result.status !== "verified") process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
