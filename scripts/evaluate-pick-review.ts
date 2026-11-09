import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { classifyPickImpact } from "../packages/domain/src/pick-impact";
const args = process.argv.slice(2);
const split = args[args.indexOf("--split") + 1];
if (
  args[args.indexOf("--mode") + 1] !== "synthetic" ||
  !["development", "holdout"].includes(split ?? "")
)
  throw Error("EXPLICIT_SYNTHETIC_MODE_AND_SPLIT_REQUIRED");
const raw = readFileSync("tests/fixtures/pick-review/cases.jsonl", "utf8");
const manifest = JSON.parse(
  readFileSync("tests/fixtures/pick-review/split-manifest.json", "utf8"),
);
if (createHash("sha256").update(raw).digest("hex") !== manifest.sha256)
  throw Error("CORPUS_HASH_MISMATCH");
const results = raw
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((c) => c.split === split)
  .map((c) => {
    try {
      const actual = classifyPickImpact(c.input);
      return {
        id: c.id,
        expected: c.expectedState,
        actual,
        passed: actual === c.expectedState,
        error: null,
      };
    } catch {
      return {
        id: c.id,
        expected: c.expectedState,
        actual: null,
        passed: false,
        error: "CLASSIFICATION_FAILED",
      };
    }
  });
const report = {
  mode: "synthetic",
  split,
  corpusHash: manifest.sha256,
  scope: manifest.scope,
  total: results.length,
  passed: results.filter((r) => r.passed).length,
  results,
  predictiveAccuracyClaim: false,
  modelComparisonRun: false,
  independentHumanReview: false,
};
mkdirSync(".local/pick-review-evaluation", { recursive: true });
writeFileSync(
  `.local/pick-review-evaluation/${split}.json`,
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    split,
    total: report.total,
    passed: report.passed,
    scope: report.scope,
  }),
);
if (!results.length || report.passed !== report.total) process.exitCode = 1;
