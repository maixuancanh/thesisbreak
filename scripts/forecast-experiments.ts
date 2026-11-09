import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildAblationPairs,
  buildRollingExperiment,
  digest,
  scoreHumanExperiment,
  savedResponseSchema,
  type RollingPlan,
  type SavedExperimentResponse,
} from "../packages/domain/src/forecast-experiments";
import { createOfficialGenerator } from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";

const [command, corpusPath, planPath, outputPath, reviewsPath] =
  process.argv.slice(2);
if (
  !command ||
  !corpusPath ||
  !planPath ||
  !outputPath ||
  !["prepare", "run", "score"].includes(command)
) {
  throw new Error(
    "Usage: tsx scripts/forecast-experiments.ts prepare|run|score CORPUS.json PLAN.json NEW_OUTPUT_DIR [REVIEWS.json]. run makes paid model calls; score reads an existing output directory.",
  );
}
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));
const corpus = await readJson(corpusPath);
const plan = (await readJson(planPath)) as RollingPlan;
const asOf = new Date().toISOString();
const experiment = buildRollingExperiment(corpus, plan, asOf);
const pairs = buildAblationPairs(corpus, plan, asOf);
const output = resolve(outputPath);
if (command === "score") {
  if (!reviewsPath) throw new Error("REVIEWS_REQUIRED");
  const frozen = (await readJson(
    resolve(output, "manifest.json"),
  )) as typeof experiment;
  if (
    frozen.corpusHash !== experiment.corpusHash ||
    frozen.planHash !== experiment.planHash
  )
    throw new Error("MANIFEST_CHANGED");
  const rows = (await readFile(resolve(output, "responses.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => savedResponseSchema.parse(JSON.parse(line)));
  for (const row of rows) {
    const pair = pairs.find((p) => p.eventId === row.eventId);
    const branch = pair?.branches.find((b) => b.branch === row.branch);
    if (
      !pair ||
      !branch ||
      pair.model !== row.model ||
      pair.commonHash !== row.commonHash ||
      digest(branch.prompt) !== row.promptHash
    )
      throw new Error("RESPONSE_MANIFEST_MISMATCH");
  }
  if (rows.length !== pairs.length * 2)
    throw new Error("MISSING_RESPONSE_ATTEMPTS");
  const reviewInput = await readJson(reviewsPath);
  if (!Array.isArray(reviewInput)) throw new Error("REVIEWS_ARRAY_REQUIRED");
  const result = scoreHumanExperiment(rows, reviewInput);
  await writeFile(
    resolve(output, "human-results.json"),
    JSON.stringify(result, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(result, null, 2));
} else {
  // Never replace an earlier frozen experiment or its failed attempts.
  await mkdir(output, { recursive: false });
  await writeFile(
    resolve(output, "corpus.json"),
    JSON.stringify(corpus, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "manifest.json"),
    JSON.stringify(experiment, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "inputs.json"),
    JSON.stringify(pairs, null, 2),
    { flag: "wx" },
  );
  if (command === "run") {
    const config = parseLlmConfig(process.env);
    if (config.model !== experiment.plan.model)
      throw new Error("MODEL_MISMATCH");
    const generate = createOfficialGenerator(process.env);
    const rows: SavedExperimentResponse[] = [];
    const { open } = await import("node:fs/promises");
    const stream = await open(resolve(output, "responses.jsonl"), "wx");
    try {
      for (const pair of pairs)
        for (const branch of pair.branches) {
          const startedAt = new Date().toISOString();
          let rawResponse: string | null = null,
            error: string | null = null;
          try {
            let prompt = branch.prompt;
            if (branch.branch === "with_history") {
              if (!process.argv.includes("--enable-evaluation-memory"))
                throw Error("EVALUATION_REMOTE_MEMORY_CONSENT_REQUIRED");
              const adapter = new MemwalAdapter(
                officialMemwalClient(parseMemwalConfig(process.env)),
                `evaluation:${experiment.namespace}`,
              );
              try {
                const input = JSON.parse(branch.prompt);
                const record = {
                  logicalId: `evaluation:${pair.eventId}`,
                  type: "forecast.evaluation.history",
                  version: 1,
                  recordedAt: new Date().toISOString(),
                  payload: {
                    namespace: experiment.namespace,
                    mode: experiment.mode,
                    eventId: pair.eventId,
                    sourceHistory: input.sourceHistory,
                  },
                };
                const receipt = await adapter.remember(record);
                if (receipt.status !== "verified")
                  throw Error("EVALUATION_MEMORY_UNVERIFIED");
                adapter.destroy();
                const fresh = new MemwalAdapter(
                  officialMemwalClient(parseMemwalConfig(process.env)),
                  `evaluation:${experiment.namespace}`,
                );
                try {
                  const recalled = await fresh.recall(
                    JSON.stringify(record.payload),
                  );
                  const exact = recalled.sources.find(
                    (s) =>
                      s.blobId === receipt.blobId &&
                      s.record.hash === receipt.hash &&
                      s.record.logicalId === record.logicalId &&
                      s.record.version === 1,
                  );
                  if (
                    !exact ||
                    JSON.stringify(exact.record.payload) !==
                      JSON.stringify(record.payload)
                  ) {
                    const stable = (x: unknown): string =>
                      x !== null && typeof x === "object"
                        ? Array.isArray(x)
                          ? `[${x.map(stable)}]`
                          : `{${Object.entries(x)
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(
                                ([k, v]) => `${JSON.stringify(k)}:${stable(v)}`,
                              )}}`
                        : JSON.stringify(x);
                    if (
                      !exact ||
                      stable(exact.record.payload) !== stable(record.payload)
                    )
                      throw Error("EVALUATION_MEMORY_MISMATCH");
                  }
                  // Exact semantic readback validated above; retain the frozen JSON key order for paired prompt hashes.
                  prompt = branch.prompt;
                  await writeFile(
                    resolve(
                      output,
                      `memory-${pair.eventId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
                    ),
                    JSON.stringify(
                      {
                        eventId: pair.eventId,
                        namespace: experiment.namespace,
                        receipt,
                        freshReadback: true,
                        recordedAt: record.recordedAt,
                      },
                      null,
                      2,
                    ),
                    { flag: "wx" },
                  );
                } finally {
                  fresh.destroy();
                }
              } finally {
                adapter.destroy();
              }
            }
            rawResponse = JSON.stringify(
              await generate({ system: pair.system, prompt }),
            );
          } catch {
            // Do not serialize provider error causes which may carry request credentials.
            error = "GENERATION_UNAVAILABLE";
          }
          const row: SavedExperimentResponse = {
            eventId: pair.eventId,
            responseId: randomUUID(),
            branch: branch.branch,
            model: pair.model,
            commonHash: pair.commonHash,
            promptHash: digest(branch.prompt),
            rawResponse,
            responseHash: rawResponse === null ? null : digest(rawResponse),
            error,
            startedAt,
            completedAt: new Date().toISOString(),
          };
          await stream.write(`${JSON.stringify(row)}\n`);
          await stream.sync();
          rows.push(row);
        }
    } finally {
      await stream.close();
    }
    // Reviewer packet conceals branch and prompt; keep the manifest and mapping private until review finishes.
    // Hash order is deterministic but unrelated to branch or call order.
    const blind = rows
      .filter((r) => r.rawResponse !== null)
      .map((r) => ({
        eventId: r.eventId,
        responseId: r.responseId,
        responseHash: r.responseHash,
        rawResponse: r.rawResponse,
        completedAt: r.completedAt,
      }))
      .sort((a, b) => digest(a.responseId).localeCompare(digest(b.responseId)));
    await writeFile(
      resolve(output, "blinded-responses.json"),
      JSON.stringify(blind, null, 2),
      { flag: "wx" },
    );
    console.log(
      `Saved ${rows.length} response attempts; ${rows.filter((r) => r.error).length} failures. Human rubric review required.`,
    );
  } else
    console.log(
      `Prepared ${pairs.length} held-out event pairs. No model calls or human scores produced.`,
    );
}
