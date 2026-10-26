/** Uses only THESISBREAK configuration. Read-only recall; no memory writes. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { runResearch } from "../packages/agent/src/runtime";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
const userId = `thesisbreak-connectivity-${randomUUID()}`;
let failed = false;
let phase = "planner";
try {
  const planner = createOfficialPlanner(process.env),
    generator = createOfficialGenerator(process.env);
  const result = await runResearch(
    {
      userId,
      market: {
        platform: "kalshi",
        nativeId: "CONNECTION-TEST",
        question: "Illustrative fixture: Will the stated condition occur?",
        outcomes: ["Yes", "No"],
        rules: "Illustrative connectivity fixture only; not a real market.",
      },
      message:
        "Explain the difference between the market price and my own view. Do not propose a pick.",
      history: [],
      domain: "test",
      now: new Date(),
    },
    {
      plan: async (input) => {
        const result = await planner(input);
        phase = "generation";
        return result;
      },
      generate: generator,
      readPick: async () => null,
      readLessons: async () => [],
      readComparison: async () => [],
      marketSource: {
        id: "market-source",
        text: "This is an illustrative fixture, not an independent news source.",
        url: "",
        retrievedAt: new Date().toISOString(),
      },
    },
  );
  console.log(
    JSON.stringify({
      check: "llm.structured_runtime",
      status: "pass",
      replyCharacters: result.reply.message.length,
      citations: result.reply.evidenceRefs.length,
    }),
  );
} catch {
  failed = true;
  console.log(
    JSON.stringify({
      check: "llm.structured_runtime",
      status: "failed",
      detail:
        "Provider call or structured-output validation failed; no credentials logged",
      phase,
    }),
  );
}
let adapter: MemwalAdapter | undefined;
try {
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    userId,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    adapter.recall(
      "THESISBREAK connection check in an empty isolated namespace",
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 30000);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  console.log(
    JSON.stringify({
      check: "walrus.isolated_recall",
      status: "pass",
      records: result.records.length,
      detail: "Read-only SDK connectivity; not a Mainnet write/readback proof",
    }),
  );
} catch {
  failed = true;
  console.log(
    JSON.stringify({
      check: "walrus.isolated_recall",
      status: "failed",
      detail: "Recall unavailable; no provider body or credentials logged",
    }),
  );
} finally {
  adapter?.destroy();
}
if (failed) process.exitCode = 1;
