import { spawn } from "node:child_process";
import { z } from "zod";
import type { Pool } from "pg";
import {
  claimResearchJob,
  finishResearchJob,
  failResearchJob,
  claimTypedResearchJob,
} from "../../db/src/research-jobs";
import {
  researchInputSchema,
  researchRequest,
} from "../../db/src/research-inputs";
import { researchEnvelopeSchema } from "../../domain/src/strengthening-contracts";

export const researchFlagsSchema = z.object({
  RESEARCH_WORKER_ENABLED: z.enum(["true", "false"]).default("false"),
  FORECAST_CHALLENGER_MODE: z.enum(["off", "shadow"]).default("off"),
  GRAPH_RETRIEVAL_MODE: z.enum(["off", "shadow", "verified"]).default("off"),
  SOURCE_WATCH_ENABLED: z.enum(["true", "false"]).default("false"),
  DEBATE_MODE: z.enum(["off", "opt_in"]).default("off"),
});
export function researchFlags(
  env: Readonly<Record<string, string | undefined>>,
) {
  return researchFlagsSchema.parse(
    Object.fromEntries(
      Object.keys(researchFlagsSchema.shape).map((k) => [k, env[k]]),
    ),
  );
}
/** Runs only on the separate trusted worker host. No shell and no inherited application secrets. */
export function pythonResearch(input: {
  python: string;
  cwd: string;
  request: unknown;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify(input.request);
  if (Buffer.byteLength(serialized) > 1_000_000)
    throw Error("RESEARCH_INPUT_LIMIT");
  return new Promise((resolve, reject) => {
    const child = spawn(input.python, ["-m", "thesisbreak_research.cli"], {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        PYTHONPATH: "src",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      done = false;
    const end = (error?: Error, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value!);
    };
    const timer = setTimeout(
      () => end(Error("RESEARCH_TIMEOUT")),
      input.timeoutMs ?? 60_000,
    );
    child.on("error", () => end(Error("RESEARCH_PROCESS_UNAVAILABLE")));
    child.stdin.on("error", () => end(Error("RESEARCH_PIPE_FAILED")));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 1_000_000)
        end(Error("RESEARCH_OUTPUT_LIMIT"));
    });
    child.stderr.resume();
    child.on("close", (code) => {
      if (done) return;
      try {
        const response = z
          .object({
            ok: z.literal(true),
            result: z.record(z.string(), z.unknown()),
          })
          .strict()
          .parse(JSON.parse(output));
        if (code !== 0) throw Error();
        end(undefined, response.result);
      } catch {
        end(Error("RESEARCH_PROCESS_FAILED"));
      }
    });
    child.stdin.end(serialized);
  });
}
/** Queue consumes only envelope validation jobs until typed forecast artifact inputs are supplied. */
export async function runResearchValidationJob(
  pool: Pool,
  input: {
    ownerId: string;
    enabled: boolean;
    execute: (request: unknown) => Promise<Record<string, unknown>>;
  },
) {
  if (!input.enabled) return { checked: 0, completed: 0, disabled: true };
  const job = await claimResearchJob(pool, {
    ownerId: input.ownerId,
    kind: "contract_validation",
    leaseSeconds: 120,
  });
  if (!job) return { checked: 0, completed: 0 };
  try {
    const envelope = researchEnvelopeSchema.parse(job.payload);
    if (envelope.ownerId !== input.ownerId || envelope.jobId !== job.id)
      throw Error("RESEARCH_IDENTITY_MISMATCH");
    // Python mirror independently validates this same envelope.
    const result = await input.execute({
      operation: "validate_contract",
      payload: envelope,
    });
    if (result.valid !== true) throw Error("RESEARCH_CONTRACT_REJECTED");
    await finishResearchJob(pool, {
      id: job.id,
      ownerId: input.ownerId,
      token: job.lease_token,
      result,
    });
    return { checked: 1, completed: 1 };
  } catch {
    await failResearchJob(pool, {
      id: job.id,
      ownerId: input.ownerId,
      token: job.lease_token,
      code: "VALIDATION_FAILED",
    });
    return { checked: 1, completed: 0 };
  }
}

export async function runTypedResearchJob(
  pool: Pool,
  input: {
    ownerId: string;
    enabled: boolean;
    dailyQuota: number;
    remainingMs: number;
    execute: (
      request: unknown,
      timeoutMs: number,
    ) => Promise<Record<string, unknown>>;
  },
) {
  if (!input.enabled || input.remainingMs < 1000)
    return { checked: 0, completed: 0 };
  const job = await claimTypedResearchJob(pool, {
    ownerId: input.ownerId,
    dailyQuota: input.dailyQuota,
    leaseSeconds: 120,
  });
  if (!job) return { checked: 0, completed: 0 };
  try {
    const envelope = researchEnvelopeSchema.parse(job.payload);
    if (envelope.ownerId !== input.ownerId || envelope.jobId !== job.id)
      throw Error("RESEARCH_IDENTITY_MISMATCH");
    const artifact = researchInputSchema.parse(job.artifact);
    if (envelope.namespace === "live") {
      const consent = await pool.query(
        "SELECT 1 FROM nba_forecast_subscriptions WHERE user_id=$1 AND enabled=true AND memory_consent=true",
        [input.ownerId],
      );
      if (!consent.rowCount) throw Error("RESEARCH_CONSENT_REQUIRED");
    }
    if (artifact.operation !== job.kind)
      throw Error("RESEARCH_OPERATION_MISMATCH");
    // Optimizer consent is separate from memory storage consent. These trusted
    // queue artifacts carry observed traces or an isolated action environment;
    // neither path authorizes provider calls, holdout access or promotion.
    if (
      artifact.operation === "procedure_evaluate" ||
      artifact.operation === "procedure_optimize"
    ) {
      if (artifact.payload.requestedBy !== input.ownerId)
        throw Error("RESEARCH_OWNER_MISMATCH");
      if (artifact.payload.mode !== envelope.mode)
        throw Error("RESEARCH_MODE_MISMATCH");
      if (envelope.namespace === "live")
        throw Error("OPTIMIZER_EVALUATION_NAMESPACE_REQUIRED");
    }
    const timeoutMs = Math.floor(
      Math.min(
        60000,
        input.remainingMs - 500,
        new Date(job.lease_until).getTime() - Date.now() - 1000,
      ),
    );
    if (timeoutMs < 1) throw Error("RESEARCH_DEADLINE_EXCEEDED");
    const result = await input.execute(researchRequest(artifact), timeoutMs);
    await finishResearchJob(pool, {
      id: job.id,
      ownerId: input.ownerId,
      token: job.lease_token,
      result,
    });
    return { checked: 1, completed: 1 };
  } catch (error) {
    await failResearchJob(pool, {
      id: job.id,
      ownerId: input.ownerId,
      token: job.lease_token,
      code:
        error instanceof Error &&
        error.message === "AUTHORIZED_EVALUATOR_REQUIRED"
          ? "AUTHORIZED_EVALUATOR_REQUIRED"
          : "RESEARCH_EXECUTION_FAILED",
    });
    return { checked: 1, completed: 0 };
  }
}
