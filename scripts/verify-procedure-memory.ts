import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";
import {
  enqueueProcedureMemory,
  claimProcedureMemory,
  finishProcedureMemory,
  loadProcedureMemory,
  assertProcedureMemoryAuthority,
  markProcedureFreshRead,
} from "../packages/db/src/procedure-memory";
import {
  publishProcedureProvenance,
  verifyProcedureProvenance,
} from "../packages/integrations/src/procedure-memory";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("publish"),
      evaluationOwnerId: z.string().min(1),
      reviewerId: z.string().min(1),
      procedureId: z.string().min(1),
      consentGrantId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("fresh-read"),
      evaluationOwnerId: z.string().min(1),
      reviewerId: z.string().min(1),
      publicationId: z.string().min(1),
    })
    .strict(),
]);
if (!process.argv[2])
  throw Error(
    "Usage: node --env-file=.env --import tsx scripts/verify-procedure-memory.ts request.json",
  );
const request = schema.parse(
  JSON.parse(await readFile(process.argv[2], "utf8")),
);
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
try {
  const id =
    request.action === "publish"
      ? await enqueueProcedureMemory(pool, {
          ownerId: request.evaluationOwnerId,
          reviewerId: request.reviewerId,
          procedureId: request.procedureId,
          grantId: request.consentGrantId,
        })
      : request.publicationId;
  const identity = {
    id,
    ownerId: request.evaluationOwnerId,
    reviewerId: request.reviewerId,
  };
  const claim =
    request.action === "publish"
      ? await claimProcedureMemory(pool, identity)
      : await loadProcedureMemory(pool, identity);
  if (!claim) throw Error("PROCEDURE_PUBLICATION_NOT_CLAIMABLE");
  // Credential parsing and SDK construction occur only after the existing consent/role/snapshot checks.
  await assertProcedureMemoryAuthority(pool, claim);
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    request.evaluationOwnerId,
    "procedure_provenance",
  );
  const deps = {
    assertAuthority: () => assertProcedureMemoryAuthority(pool, claim),
  };
  if (request.action === "publish") {
    const result = await publishProcedureProvenance(claim, {
      ...deps,
      remember: (r) => adapter!.remember(r),
    });
    const saved = await finishProcedureMemory(pool, claim, result);
    console.log(
      JSON.stringify({
        publicationId: id,
        namespace: adapter.namespace,
        writeAndReceipt: saved ? "verified" : "unverified",
        freshRead: "not_run",
        runtimeUse: "not_run",
      }),
    );
    if (!saved) process.exitCode = 1;
  } else {
    if (!claim.receipt) throw Error("PROCEDURE_RECEIPT_REQUIRED");
    const result = await verifyProcedureProvenance(
      { ...claim, receipt: claim.receipt },
      { ...deps, recall: (q) => adapter!.recall(q) },
    );
    const saved =
      result.status === "verified" &&
      (await markProcedureFreshRead(pool, claim, result));
    console.log(
      JSON.stringify({
        publicationId: id,
        writeAndReceipt: "recorded",
        freshRead: saved ? "verified" : "unverified",
        runtimeUse: "not_run",
      }),
    );
    if (!saved) process.exitCode = 1;
  }
} finally {
  adapter?.destroy();
  await pool.end();
}
