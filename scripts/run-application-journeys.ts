/** Isolated application DB executor. No production connection or remote memory writes. */
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  assertJourneyDatabase,
  executeApplicationJourney,
  initializeJourneyStore,
  journeyHash,
  type ApplicationJourneyFixture,
  type HumanDecision,
  type JourneyBindings,
} from "../packages/agent/src/application-journey";
import { journeyHumanDecisionPacket } from "../packages/agent/src/journey-human-packet";
import { selectFrozenCases } from "../packages/domain/src/frozen-corpus-selection";
import {
  createOfficialGenerator,
  createOfficialPlanner,
} from "../packages/agent/src/provider";
import { loadCurrentApprovedLessons } from "../packages/db/src/approved-lessons";
import { authorizedRecalledLessons } from "../packages/agent/src/recalled-lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
const argument = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = argument("output"),
  runId = argument("run-id"),
  bindingPath = argument("bindings");
if (!output || !runId || !bindingPath)
  throw Error("REQUIRED_OUTPUT_RUN_ID_AND_BINDINGS");
const url = process.env.JOURNEY_EVAL_DATABASE_URL;
if (!url) throw Error("JOURNEY_EVAL_DATABASE_URL_REQUIRED");
assertJourneyDatabase(url, process.env.DATABASE_URL);
const live = process.argv.includes("--live-model");
const scripted = process.argv.includes("--scripted-model");
if (live && scripted) throw Error("CHOOSE_ONE_MODEL_MODE");
const freshWalrus = process.argv.includes("--fresh-walrus");
const maxCases = Number(argument("max-cases") ?? 12),
  maxCalls = Number(argument("max-calls") ?? 24);
if (
  !Number.isInteger(maxCases) ||
  maxCases < 1 ||
  maxCases > 12 ||
  !Number.isInteger(maxCalls) ||
  maxCalls < 1 ||
  maxCalls > 100
)
  throw Error("INVALID_BOUNDS");
const raw = await readFile("tests/fixtures/agent-journeys/cases.jsonl", "utf8");
const corpusHash = createHash("sha256").update(raw).digest("hex");
const manifest = JSON.parse(
  await readFile("tests/fixtures/agent-journeys/split-manifest.json", "utf8"),
);
if (manifest.corpusSha256 !== corpusHash) throw Error("CORPUS_HASH_MISMATCH");
const bindings = JSON.parse(await readFile(bindingPath, "utf8")) as Record<
  string,
  JourneyBindings
>;
const decisionPath = argument("human-decisions");
const decisions: HumanDecision[] = decisionPath
  ? JSON.parse(await readFile(decisionPath, "utf8"))
  : [];
const cases = selectFrozenCases(raw, manifest, {
  split: "all_unsealed",
  limit: 100,
})
  .filter((c) => !argument("case") || argument("case") === c.id)
  .slice(0, maxCases) as unknown as ApplicationJourneyFixture[];
if (!cases.length) throw Error("NO_ELIGIBLE_JOURNEY_CASES");
// New output per attempt; DB run-id resumes prior state with exact completed-step hashes.
await mkdir(output, { recursive: false });
const pool = new Pool({
  connectionString: url,
  max: 3,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  options: "-c search_path=public",
});
const reports: Awaited<ReturnType<typeof executeApplicationJourney>>[] = [];
try {
  await initializeJourneyStore(pool);
  for (const fixture of cases) {
    const report = await executeApplicationJourney({
      pool,
      runId,
      fixture,
      bindings: bindings[fixture.id] ?? {},
      decisions,
      maxCalls,
      ...(freshWalrus
        ? {
            recall: async (ownerId: string, query: string) => {
              const adapter = new MemwalAdapter(
                officialMemwalClient(parseMemwalConfig(process.env)),
                ownerId,
              );
              try {
                const recalled = await adapter.recall(query);
                const current = await loadCurrentApprovedLessons(pool, ownerId);
                return authorizedRecalledLessons(current, recalled.records);
              } finally {
                adapter.destroy();
              }
            },
          }
        : {}),
      plan: live
        ? createOfficialPlanner(process.env)
        : scripted
          ? async () => ({
              tools: [
                "read_saved_pick",
                "read_independent_sources",
                "read_approved_lessons",
              ],
            })
          : async () => {
              throw Error("LIVE_MODEL_OPT_IN_REQUIRED");
            },
      generate: live
        ? createOfficialGenerator(process.env)
        : scripted
          ? async (request) => ({
              message:
                "Synthetic scripted response for application plumbing only.",
              evidenceRefs: [],
              lessonRefs: [],
              proposedChange: null,
              proposedPick: /draft a new Yes pick/.test(
                JSON.parse(request.prompt).userMessage,
              )
                ? {
                    outcome: "Yes",
                    reason: "Explicit synthetic evaluation choice.",
                  }
                : null,
            })
          : async () => {
              throw Error("LIVE_MODEL_OPT_IN_REQUIRED");
            },
      onTrace: async (trace) => {
        await appendFile(
          `${output}/attempts.jsonl`,
          JSON.stringify({ caseId: fixture.id, ...trace }) + "\n",
          { mode: 0o600 },
        );
      },
    });
    reports.push(report);
  }
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        execution: "actual_application_services",
        model: live
          ? "explicit_live_opt_in"
          : scripted
            ? "synthetic_scripted_provider"
            : "disabled",
        memoryTransport: freshWalrus
          ? "fresh_authorized_walrus_read_only"
          : "unconfigured_no_remote_reads",
        corpusHash,
        runId,
        reports,
        hostedAcceptance: false,
        predictiveClaim: false,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    `${output}/pending-human-decisions.json`,
    JSON.stringify(
      (
        await Promise.all(
          cases.map(async (c) => [
            {
              caseId: c.id,
              stepId: `${c.id}:initial-consent`,
              action: { fixtureId: c.id, enabled: true },
              binding: null,
              actionHash: journeyHash([
                runId,
                { fixtureId: c.id, enabled: true },
              ]),
              status: "awaiting_user",
            },
            ...(await Promise.all(
              c.steps
                .filter((s) =>
                  [
                    "user_confirm",
                    "user_reject",
                    "user_review",
                    "consent",
                  ].includes(s.action.type),
                )
                .map((step) =>
                  journeyHumanDecisionPacket({
                    pool,
                    runId,
                    fixture: c,
                    step,
                    binding: bindings[c.id]?.[step.id],
                    state: reports.find((r) => r.fixtureId === c.id)!.state,
                  }),
                ),
            )),
          ]),
        )
      ).flat(),
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      cases: reports.length,
      statuses: reports.map((r) => r.status),
      execution: "actual_application_services",
      hostedAcceptance: false,
    }),
  );
} finally {
  await pool.end();
}
