import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { selectFrozenCases } from "../packages/domain/src/frozen-corpus-selection";
import {
  AgentJourney,
  scoreJourney,
  type JourneyAction,
} from "../packages/domain/src/agent-journey";
const output = process.argv.find((a) => a.startsWith("--output="))?.slice(9);
if (!output) throw Error("NEW_OUTPUT_DIRECTORY_REQUIRED");
const raw = await readFile("tests/fixtures/agent-journeys/cases.jsonl", "utf8"),
  manifest = JSON.parse(
    await readFile("tests/fixtures/agent-journeys/split-manifest.json", "utf8"),
  );
const hash = createHash("sha256").update(raw).digest("hex");
if (hash !== manifest.corpusSha256) throw Error("CORPUS_HASH_MISMATCH");
type Fixture = {
  eventId: string;
  now: string;
  id: string;
  family: string;
  ownerId: string;
  namespace: string;
  steps: {
    id: string;
    actor: "agent" | "synthetic_user";
    action: JourneyAction;
    violations: string[];
  }[];
};
const sealed = process.argv.includes("--sealed");
const cases = selectFrozenCases(raw, manifest, {
  split: sealed ? "sealed-test" : "all_unsealed",
  allowSealed: sealed,
  limit: 100,
}).map((c) => c as unknown as Fixture);
const attempts = cases.map((c) => {
  const env = new AgentJourney(c);
  const trace = c.steps.map((s) => ({
    step: s.id,
    actor: s.actor,
    action: s.action,
    result: env.step(s.id, s.actor, s.action),
  }));
  return {
    id: c.id,
    trace,
    score: scoreJourney(
      env.checkpoint(),
      c.steps.map((s) => ({ stepId: s.id, violations: s.violations })),
    ),
    checkpoint: env.checkpoint(),
  };
});
await mkdir(output, { recursive: true });
await writeFile(
  `${output}/report.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      execution: "synthetic_environment",
      corpusHash: hash,
      cases: attempts.length,
      attempts,
      hostedAcceptance: false,
      predictiveClaim: false,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    execution: "synthetic_environment",
    cases: attempts.length,
    passed: attempts.filter((a) => a.score.passed).length,
    predictiveClaim: false,
  }),
);
