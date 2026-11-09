import { z } from "zod";

export type RequestStage =
  | "authorization"
  | "configuration"
  | "input"
  | "review_context"
  | "history"
  | "idempotency"
  | "memory_recall"
  | "market_resolution"
  | "claim_run"
  | "market_read"
  | "research"
  | "planning"
  | "generation"
  | "persist_result"
  | "persist_failure";

/** Fixed categories only: never serialize arbitrary errors, stacks or payloads. */
export function failureCategory(error: unknown): string {
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    error && typeof error === "object" && depth < 6;
    depth++
  ) {
    if (seen.has(error)) break;
    seen.add(error);
    if (error instanceof z.ZodError) return "schema_validation";
    const value = error as {
      name?: unknown;
      code?: unknown;
      statusCode?: unknown;
      cause?: unknown;
      message?: unknown;
    };
    if (
      [
        "INVALID_ANSWER_CLAIM",
        "UNKNOWN_CITATION",
        "UNKNOWN_REVIEW_CITATION",
        "SETTLEMENT_CITATION_REQUIRED",
      ].includes(String(value.message ?? ""))
    )
      return "citation_validation";
    if (value.name === "TimeoutError" || value.code === "ETIMEDOUT")
      return "timeout";
    if (value.name === "AbortError") return "cancelled";
    if (value.statusCode === 429) return "upstream_rate_limit";
    if (value.statusCode === 401 || value.statusCode === 403)
      return "upstream_auth";
    if (typeof value.statusCode === "number" && value.statusCode >= 500)
      return "upstream_server";
    if (
      typeof value.code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(
        value.code,
      )
    )
      return "network";
    if (
      typeof value.code === "string" &&
      /^(08|53|57)[0-9A-Z]{3}$/.test(value.code)
    )
      return "database_unavailable";
    if (value.name === "SyntaxError") return "invalid_json";
    if (
      value.name === "AI_NoObjectGeneratedError" ||
      value.name === "AI_TypeValidationError"
    )
      return "schema_validation";
    error = value.cause;
  }
  return "unknown";
}

export function logRequestFailure(
  event:
    "agent_request_failed" | "agent_history_failed" | "session_message_failed",
  stage: RequestStage,
  error: unknown,
  status: number,
  runId?: string,
) {
  console.error(event, {
    stage,
    category: failureCategory(error),
    runId:
      runId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId)
        ? runId
        : null,
    status,
  });
}
