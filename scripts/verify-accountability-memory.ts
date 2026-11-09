import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";
import {
  loadResearchArtifactMemory,
  assertResearchArtifactAuthority,
} from "../packages/db/src/research-artifact-memory";
import { recallResearchArtifactForPlanning } from "../packages/integrations/src/research-artifact-memory";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
// Read-only remote verification of an already published, exactly granted artifact.
// Never creates consent, enqueues publication, or writes new remote memory.
const schema = z
  .object({
    action: z.literal("fresh-read"),
    ownerId: z.string().min(1),
    publicationId: z.string().min(1),
  })
  .strict();
if (!process.argv[2])
  throw Error(
    "Usage: node --env-file=.env --import tsx scripts/verify-accountability-memory.ts request.json",
  );
const input = schema.parse(JSON.parse(await readFile(process.argv[2], "utf8")));
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const identity = {
    id: input.publicationId,
    ownerId: input.ownerId,
    reviewerId: input.ownerId,
  };
  const artifact = await loadResearchArtifactMemory(pool, identity);
  if (artifact.kind !== "accountability_review")
    throw Error("ACCOUNTABILITY_ARTIFACT_REQUIRED");
  await assertResearchArtifactAuthority(pool, artifact);
  const result = await recallResearchArtifactForPlanning(pool, {
    ...identity,
    createAdapter: () =>
      new MemwalAdapter(
        officialMemwalClient(parseMemwalConfig(process.env)),
        input.ownerId,
      ),
  });
  console.log(
    JSON.stringify({
      publicationId: input.publicationId,
      kind: artifact.kind,
      freshRead: result.status,
      checks: result.checks,
      runtimeUse: "not_run",
      remoteWrite: "not_run",
    }),
  );
  if (result.status !== "verified") process.exitCode = 1;
} finally {
  await pool.end();
}
