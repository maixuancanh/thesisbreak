import { learningSnapshotHash } from "./learning-provenance";
export type ToolExecutionTrace = {
  tool: string;
  status: "completed" | "failed" | "unavailable";
  count: number;
  reason?: string;
  startedAt: string | null;
  completedAt: string | null;
  observedAt: string | null;
  observationKind: "provider_timestamp" | "retrieval_timestamp" | null;
  resultHash: string | null;
};
function observation(
  value: unknown,
  provider: boolean,
): Pick<ToolExecutionTrace, "observedAt" | "observationKind"> {
  if (!provider) return { observedAt: null, observationKind: null };
  const rows = Array.isArray(value) ? value : [value];
  const times = rows.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const r = v as Record<string, unknown>;
    const direct = r.quoteObservedAt ?? r.observedAt;
    const stamp = direct ?? r.retrievedAt;
    if (typeof stamp !== "string" || !Number.isFinite(Date.parse(stamp)))
      return [];
    return [
      {
        stamp,
        kind: direct
          ? ("provider_timestamp" as const)
          : ("retrieval_timestamp" as const),
      },
    ];
  });
  if (!times.length) return { observedAt: null, observationKind: null };
  const newest = times.sort(
    (a, b) => Date.parse(b.stamp) - Date.parse(a.stamp),
  )[0]!;
  return { observedAt: newest.stamp, observationKind: newest.kind };
}
export function preloadedToolTrace(
  tool: string,
  value: unknown,
): ToolExecutionTrace {
  return {
    tool,
    status: "completed",
    count: Array.isArray(value) ? value.length : value == null ? 0 : 1,
    startedAt: null,
    completedAt: null,
    ...observation(value, true),
    resultHash: learningSnapshotHash(value),
  };
}
/** Hashes are structural local result digests, not provider signatures or Walrus hashes. */
export function traceRead<A extends unknown[], R>(
  tool: string,
  read: (...args: A) => Promise<R>,
  trace: ToolExecutionTrace[],
  provider = false,
) {
  return async (...args: A): Promise<R> => {
    const startedAt = new Date().toISOString();
    try {
      const result = await read(...args);
      trace.push({
        tool,
        status: "completed",
        count: Array.isArray(result) ? result.length : result == null ? 0 : 1,
        startedAt,
        completedAt: new Date().toISOString(),
        ...observation(result, provider),
        resultHash: learningSnapshotHash(result),
      });
      return result;
    } catch (error) {
      trace.push({
        tool,
        status: "failed",
        count: 0,
        reason: provider ? "provider_read_failed" : "read_failed",
        startedAt,
        completedAt: new Date().toISOString(),
        observedAt: null,
        observationKind: null,
        resultHash: null,
      });
      throw error;
    }
  };
}
