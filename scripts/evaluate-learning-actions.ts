import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateLearningPairs } from "../packages/domain/src/learning-evaluation";
// Explicit file input only: fixtures/traces never enter real-user records.
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath)
  throw Error(
    "Usage: pnpm exec tsx scripts/evaluate-learning-actions.ts attempts.json report.json",
  );
const attempts: unknown = JSON.parse(
  await readFile(resolve(inputPath), "utf8"),
);
if (!Array.isArray(attempts)) throw Error("ATTEMPT_ARRAY_REQUIRED");
const report = evaluateLearningPairs(attempts);
await writeFile(
  resolve(outputPath),
  JSON.stringify(
    { evaluationKind: "controlled_action_trace", ...report },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    attemptCount: report.attemptCount,
    completePairs: report.completePairs,
    failedPairs: report.failedPairs,
    output: resolve(outputPath),
  }),
);
