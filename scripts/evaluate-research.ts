import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Pool } from "pg";
import {
  createAgentContext,
  answerWithContext,
} from "../packages/agent/src/context";
import { createOfficialGenerator } from "../packages/agent/src/provider";
import { researchCases, scoreResearchReply } from "../evals/research-quality";
import { listLessons } from "../packages/db/src/lessons";
import { authorizedRecalledLessons } from "../packages/agent/src/recalled-lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
if (!process.argv.includes("--live-model"))
  throw Error(
    "Pass --live-model for eight bounded model calls; no remote memory writes",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
try {
  const userId = String(
    JSON.parse(readFileSync(".local/memory-journey.json", "utf8")).userId,
  );
  const owned = (await listLessons(pool, userId)).map((r) => r.lesson);
  const active = owned.find(
    (l) => l.approval === "approved" && l.status === "active",
  );
  if (!active) throw Error("ACTIVE_ACCEPTANCE_MEMORY_REQUIRED");
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    userId,
  );
  const recalled = authorizedRecalledLessons(
    owned,
    (await adapter.recall(active.rule)).records,
  );
  if (!recalled.length) throw Error("REMOTE_MEMORY_NOT_RECALLED");
  const generate = createOfficialGenerator(process.env);
  type Variant = "with_memory" | "without_memory";
  const rows: {
    case: string;
    variant: Variant;
    valid: boolean;
    reasonCorrect: boolean;
    noMutation: boolean;
    memoryReferences: number;
    durationMs: number;
    reply?: unknown;
    error?: string;
  }[] = [];
  for (const test of researchCases) {
    // Alternate order to reduce systematic order effects; context/history always fresh.
    for (const variant of (rows.length % 4 === 0
      ? ["without_memory", "with_memory"]
      : ["with_memory", "without_memory"]) as (
      "with_memory" | "without_memory"
    )[]) {
      const market = {
        platform: "kalshi" as const,
        nativeId: `EVAL-${test.id.toUpperCase()}`,
        question: "Synthetic evaluation only: does Team A win?",
        outcomes: ["Yes", "No"],
        rules: "Labelled synthetic case; no real event or forecast.",
      };
      const started = Date.now();
      try {
        const context = createAgentContext({
          userId,
          market,
          pick: {
            userId,
            pickId: "eval-pick",
            version: 1,
            market: { platform: market.platform, nativeId: market.nativeId },
            outcome: "Yes",
            reason: test.reason,
          },
          evidence: [
            {
              id: "case-evidence",
              userId,
              market: { platform: market.platform, nativeId: market.nativeId },
              text: test.text,
              publishedAt: null,
              retrievedAt: new Date().toISOString(),
              kind: test.kind,
            },
          ],
          lessons: variant === "with_memory" ? recalled : [],
          domain: "Sports",
          now: new Date(),
        });
        const reply = await answerWithContext(
          context,
          "Review the single saved reason verbatim. Give exactly one claim with its supported/contradicted/unclear status using only supplied evidence. Apply any relevant approved preference if present. Do not invent or cite memories absent from context. Do not draft a pick or retrospective.",
          generate,
        );
        rows.push({
          case: test.id,
          variant,
          valid: true,
          ...scoreResearchReply(test, reply),
          memoryReferences: reply.lessonRefs.length,
          durationMs: Date.now() - started,
          reply,
        });
      } catch {
        rows.push({
          case: test.id,
          variant,
          valid: false,
          reasonCorrect: false,
          noMutation: false,
          memoryReferences: 0,
          durationMs: Date.now() - started,
          error: "GENERATION_OR_VALIDATION_FAILED",
        });
      }
      console.log(
        JSON.stringify({
          check: "research.eval",
          case: test.id,
          variant,
          valid: rows.at(-1)?.valid,
          reasonCorrect: rows.at(-1)?.reasonCorrect,
        }),
      );
      mkdirSync(".local", { recursive: true });
      writeFileSync(
        ".local/research-evaluation-progress.json",
        JSON.stringify({ rows }, null, 2),
      );
    }
  }
  const summary = Object.fromEntries(
    ["without_memory", "with_memory"].map((v) => {
      const rs = rows.filter((r) => r.variant === v);
      return [
        v,
        {
          cases: rs.length,
          valid: rs.filter((r) => r.valid).length,
          reasonCorrect: rs.filter((r) => r.reasonCorrect).length,
          noMutation: rs.filter((r) => r.noMutation).length,
          memoryReferences: rs.reduce((n, r) => n + r.memoryReferences, 0),
        },
      ];
    }),
  );
  const report = {
    checkedAt: new Date().toISOString(),
    model: process.env.LLM_MODEL,
    scope:
      "Four fixed synthetic regression cases, one sample per variant, same model and evidence; current approved lesson read from Walrus. No training, no new memories, no prediction-accuracy or causal learning claim. Label and citation checks do not grade free-text quality. Invalid outputs count as failures.",
    summary,
    rows,
  };
  writeFileSync(
    ".local/research-evaluation.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ check: "research.eval.summary", summary }));
  if (rows.some((r) => !r.valid || !r.reasonCorrect || !r.noMutation))
    process.exitCode = 2;
} finally {
  adapter?.destroy();
  await pool.end();
}
