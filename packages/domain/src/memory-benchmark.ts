import { z } from "zod";

const time = z.iso.datetime();
export const benchmarkMemorySchema = z.object({
  id: z.string().min(1), version: z.number().int().positive(), ownerId: z.string(),
  eventId: z.string().nullable(), marketId: z.string().nullable(),
  availableAt: time, validTo: time.nullable(), status: z.enum(["approved", "revoked", "paused", "superseded"]),
  text: z.string(),
}).strict();
export const memoryBenchmarkCaseSchema = z.object({
  id: z.string(), family: z.string(), category: z.string(), dataMode: z.literal("synthetic"),
  namespace: z.string().startsWith("eval:"), ownerId: z.string(), eventId: z.string(), marketId: z.string(),
  sessions: z.array(z.object({ id: z.string(), at: time, message: z.string() }).strict()).min(2),
  query: z.string(), knownAt: time,
  memories: z.array(benchmarkMemorySchema),
  expected: z.array(z.object({ id: z.string(), version: z.number().int().positive() }).strict()),
  forbiddenMemoryIds: z.array(z.string()), goldAssertions: z.array(z.string()),
  expectedAbstention: z.boolean(),
}).strict();
export type MemoryBenchmarkCase = z.infer<typeof memoryBenchmarkCaseSchema>;
export type MemoryHit = z.infer<typeof benchmarkMemorySchema>;
export function retrievalCounts(expected: string[], actual: string[], k: number) {
  if (!Number.isInteger(k) || k < 1) throw Error("INVALID_K");
  const gold = new Set(expected), retrieved = [...new Set(actual.slice(0, k))];
  const hits = retrieved.filter(id => gold.has(id)).length;
  return { hits, relevant: gold.size, retrieved: retrieved.length,
    recallAtK: gold.size ? hits / gold.size : null,
    precisionAtK: retrieved.length ? hits / retrieved.length : null,
    recallAllAtK: gold.size ? hits === gold.size : null };
}
export function memoryRejection(c: MemoryBenchmarkCase, m: MemoryHit): string | null {
  if (m.ownerId !== c.ownerId) return "wrong_owner";
  if (m.status !== "approved") return m.status;
  if (Date.parse(m.availableAt) > Date.parse(c.knownAt)) return "future_memory";
  if (m.validTo !== null && Date.parse(m.validTo) <= Date.parse(c.knownAt)) return "expired";
  if (m.eventId !== null && m.eventId !== c.eventId) return "wrong_event";
  if (m.marketId !== null && m.marketId !== c.marketId) return "wrong_market";
  if (c.forbiddenMemoryIds.includes(m.id)) return "forbidden_memory";
  return null;
}
export function scoreMemory(input: { fixture: MemoryBenchmarkCase; retrieved: MemoryHit[];
  assertions: string[]; abstained: boolean; k?: number }) {
  const c = memoryBenchmarkCaseSchema.parse(input.fixture), k = input.k ?? 5;
  const violations: string[] = [];
  // A pointer is trusted only if it matches the frozen corpus record exactly.
  const rejected = input.retrieved.map(m => ({ id: m.id, reason:
    !c.memories.some(g => JSON.stringify(g) === JSON.stringify(m)) ? "unknown_or_modified_pointer" : memoryRejection(c, m) }))
    .filter((r): r is { id: string; reason: string } => r.reason !== null);
  violations.push(...rejected.map(r => r.reason));
  const valid = input.retrieved.slice(0, k).filter(m => !rejected.some(r => r.id === m.id));
  const metrics = retrievalCounts(c.expected.map(m => `${m.id}@${m.version}`), valid.map(m => `${m.id}@${m.version}`), k);
  const missingAssertions = c.goldAssertions.filter(a => !input.assertions.includes(a));
  if (missingAssertions.length) violations.push("gold_assertion_missing");
  if (input.assertions.some(a => !c.goldAssertions.includes(a))) violations.push("unsupported_assertion");
  if (input.abstained !== c.expectedAbstention) violations.push("abstention_mismatch");
  if (metrics.recallAllAtK === false) violations.push("memory_missing");
  return { ...metrics, rejected, missingAssertions, abstentionCorrect: input.abstained === c.expectedAbstention,
    wrongOwner: rejected.filter(r => r.reason === "wrong_owner").length,
    revoked: rejected.filter(r => r.reason === "revoked").length,
    violations: [...new Set(violations)], passed: violations.length === 0 };
}

export const evaluationTraceSchema = z.object({
  schemaVersion: z.literal(1), fixtureId: z.string(), namespace: z.string().startsWith("eval:"),
  arm: z.enum(["current_memory", "no_memory", "stale_conflicting", "unrelated"]),
  execution: z.enum(["fixture_mock", "runtime_live"]),
  modelVersion: z.string().min(1), procedureVersion: z.string().min(1),
  prompt: z.string(), response: z.string(), questionHash: z.string(), evidenceHash: z.string(),
  maxCalls: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
  retrieved: z.array(benchmarkMemorySchema), rejectedHits: z.array(z.object({ id: z.string(), reason: z.string() }).strict()),
  toolTrace: z.array(z.unknown()), assertions: z.array(z.string()), abstained: z.boolean(),
  latencyMs: z.number().finite().nonnegative(), tokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(), retryCount: z.number().int().nonnegative(),
  failure: z.string().nullable(),
}).strict();
export type EvaluationTrace = z.infer<typeof evaluationTraceSchema>;
export function validatePairedTraces(input: unknown[]) {
  const traces = input.map(t => evaluationTraceSchema.parse(t));
  const pairs = new Map<string, EvaluationTrace[]>();
  for (const trace of traces) pairs.set(trace.fixtureId, [...(pairs.get(trace.fixtureId) ?? []), trace]);
  for (const pair of pairs.values()) {
    if (new Set(pair.map(p => p.arm)).size !== pair.length) throw Error("DUPLICATE_ARM");
    const first = pair[0]!;
    for (const trace of pair) for (const key of ["namespace", "execution", "modelVersion", "procedureVersion", "questionHash", "evidenceHash", "maxCalls", "maxOutputTokens"] as const)
      if (trace[key] !== first[key]) throw Error(`UNMATCHED_PAIR:${key}`);
  }
  return { traces, completePairs: [...pairs.values()].filter(p => p.some(t => t.arm === "current_memory") && p.some(t => t.arm === "no_memory") && p.every(t => t.failure === null)).length,
    failedAttempts: traces.filter(t => t.failure !== null).length };
}
