import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";
import {
  createProcedureVersion,
  procedureContentSchema,
  procedureEvaluationSchema,
} from "../packages/domain/src/procedure-version";
import {
  saveProcedureDraft,
  sealProcedureEvaluation,
  reviewProcedureCandidate,
  promoteProcedure,
  getActiveProcedure,
} from "../packages/db/src/procedure-versions";
const common = { reviewerId: z.string().trim().min(1) };
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("draft"),
      candidate: z
        .object({
          id: z.string(),
          parentId: z.string().nullable(),
          parentHash: z.string().nullable(),
          content: procedureContentSchema,
          corpusVersion: z.string(),
          failureExampleIds: z.array(z.string()),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("evaluate"),
      versionId: z.string().min(1),
      report: procedureEvaluationSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("review"),
      versionId: z.string().min(1),
      approve: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.enum(["activate", "rollback"]),
      versionId: z.string().min(1),
      expectedActiveId: z.string().min(1).nullable(),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);
if (!process.argv[2])
  throw Error(
    "Usage: node --env-file=.env --import tsx scripts/review-procedure.ts request.json",
  );
// This script does not grant reviewer access. An operator must provision the DB allowlist separately.
const request = requestSchema.parse(
  JSON.parse(await readFile(process.argv[2], "utf8")),
);
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (request.action === "draft")
    await saveProcedureDraft(
      pool,
      request.reviewerId,
      createProcedureVersion(request.candidate),
    );
  else if (request.action === "evaluate")
    await sealProcedureEvaluation(
      pool,
      request.reviewerId,
      request.versionId,
      request.report,
    );
  else if (request.action === "review")
    await reviewProcedureCandidate(
      pool,
      request.reviewerId,
      request.versionId,
      request.approve,
    );
  else
    await promoteProcedure(pool, {
      reviewerId: request.reviewerId,
      versionId: request.versionId,
      expectedActiveId: request.expectedActiveId,
      reason: request.reason,
      rollback: request.action === "rollback",
    });
  const active = await getActiveProcedure(pool);
  console.log(
    JSON.stringify({
      action: request.action,
      activeId: active?.id ?? null,
      activeHash: active?.hash ?? null,
    }),
  );
} finally {
  await pool.end();
}
