import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createProcedureVersion,
  evaluateProcedure,
  procedureContentSchema,
  procedureEvaluationSchema,
} from "../packages/domain/src/procedure-version";
// Offline artifact validation only. Does not invent measurements or grant reviewer authority.
const inputSchema = z
  .object({
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
    evaluation: procedureEvaluationSchema,
  })
  .strict();
const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath)
  throw Error(
    "Usage: tsx scripts/evaluate-procedure-candidate.ts input.json output.json",
  );
const input = inputSchema.parse(
  JSON.parse(await readFile(resolve(inputPath), "utf8")),
);
const candidate = evaluateProcedure(
  createProcedureVersion(input.candidate),
  input.evaluation,
);
await writeFile(
  resolve(outputPath),
  JSON.stringify(
    {
      kind: "procedure_evaluation_validation",
      authority: "offline_only_requires_explicit_database_review",
      candidate,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    id: candidate.id,
    hash: candidate.hash,
    status: candidate.status,
  }),
);
