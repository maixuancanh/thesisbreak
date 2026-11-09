import { createHash } from "node:crypto";
import {
  memoryBenchmarkCaseSchema,
  retrievalCounts,
  type MemoryBenchmarkCase,
} from "../../domain/src/memory-benchmark";
import type { MemoryEdge } from "../../domain/src/memory-index";
import { retrieveLearningCandidates } from "./learning-retrieval";
import { retrieveGraphContext } from "./graph-retrieval";
/** Synthetic candidate adapter comparison; never represents hosted Graphiti or Walrus proof. */
export async function compareGraphRetrieval(rawCases: MemoryBenchmarkCase[]) {
  const cases = rawCases.map((c) => memoryBenchmarkCaseSchema.parse(c));
  const rows: {
    id: string;
    category: string;
    expected: string[];
    baselineIds: string[];
    graphIds: string[];
    baseline: ReturnType<typeof retrievalCounts>;
    graph: ReturnType<typeof retrievalCounts>;
    wrongOwner: number;
    forbiddenHits: number;
    baselineLatencyMs: number;
    graphLatencyMs: number;
  }[] = [];
  for (const c of cases) {
    const started = performance.now();
    const current = (m: MemoryBenchmarkCase["memories"][number]) =>
      m.status === "approved" &&
      (m.validTo === null || Date.parse(m.validTo) > Date.parse(c.knownAt));
    const baseline = retrieveLearningCandidates({
      userId: c.ownerId,
      query: c.query,
      knownAt: new Date(c.knownAt),
      scope: { domain: "synthetic", eventId: c.eventId },
      limit: 5,
      items: c.memories.map((m) => ({
        id: m.id,
        userId: m.ownerId,
        scope: {
          domain: "synthetic",
          ...(m.eventId ? { eventId: m.eventId } : {}),
        },
        text: m.text,
        recordedAt: m.availableAt,
        publishedAt: null,
        active: current(m),
        consented: true,
        verified: true,
      })),
    });
    const baselineLatencyMs = performance.now() - started;
    const eventDate = c.eventId.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!eventDate) throw Error("FIXTURE_NATIVE_EVENT_DATE_REQUIRED");
    const edges: MemoryEdge[] = c.memories.map((m) => ({
      id: m.id,
      namespace: c.namespace,
      pointer: {
        ownerId: m.ownerId,
        memoryId: m.id,
        version: m.version,
        sha256: createHash("sha256").update(JSON.stringify(m)).digest("hex"),
        blobId: `synthetic:${m.id}`,
      },
      event: {
        provider: "synthetic",
        nativeId: m.eventId ?? "global",
        date: eventDate,
      },
      entities: m.eventId
        ? [{ kind: "event", provider: "synthetic", nativeId: m.eventId }]
        : [],
      relation: "fixture_memory",
      text: m.text,
      evidenceIds: [`synthetic:${m.id}`],
      recordedAt: m.availableAt,
      availableAt: m.availableAt,
      validFrom: m.availableAt,
      validTo: m.validTo,
      trusted: current(m),
      scope: m.marketId ? { marketId: m.marketId } : {},
    }));
    const graphStarted = performance.now();
    const graph = await retrieveGraphContext(
      {
        ownerId: c.ownerId,
        namespace: c.namespace,
        event: { provider: "synthetic", nativeId: c.eventId, date: eventDate },
        entities: [
          { kind: "event", provider: "synthetic", nativeId: c.eventId },
        ],
        query: c.query,
        cutoffAt: c.knownAt,
        scope: { marketId: c.marketId },
      },
      {
        search: async () => edges,
        authorize: async (p) =>
          c.memories.some(
            (m) =>
              m.id === p.memoryId &&
              m.version === p.version &&
              m.ownerId === c.ownerId &&
              (m.marketId === null || m.marketId === c.marketId) &&
              current(m),
          ),
        readExact: async (p) => {
          const m = c.memories.find(
            (m) => m.id === p.memoryId && m.version === p.version,
          );
          return m ? { pointer: p, text: m.text } : null;
        },
      },
    );
    const graphLatencyMs = performance.now() - graphStarted;
    const gold = c.expected.map((m) => `${m.id}@${m.version}`);
    const baselineIds = baseline.items.map(
      (m) => `${m.id}@${c.memories.find((x) => x.id === m.id)!.version}`,
    );
    const graphIds = graph.items.map(
      (m) => `${m.pointer.memoryId}@${m.pointer.version}`,
    );
    rows.push({
      id: c.id,
      category: c.category,
      expected: gold,
      baselineIds,
      graphIds,
      baseline: retrievalCounts(gold, baselineIds, 5),
      graph: retrievalCounts(gold, graphIds, 5),
      wrongOwner: graph.items.filter((m) => m.pointer.ownerId !== c.ownerId)
        .length,
      forbiddenHits: graph.items.filter((m) =>
        c.forbiddenMemoryIds.includes(m.pointer.memoryId),
      ).length,
      baselineLatencyMs,
      graphLatencyMs,
    });
  }
  const metric = (arm: "baseline" | "graph") => ({
    hits: rows.reduce((n, r) => n + r[arm].hits, 0),
    relevant: rows.reduce((n, r) => n + r[arm].relevant, 0),
    retrieved: rows.reduce((n, r) => n + r[arm].retrieved, 0),
  });
  return {
    execution: "synthetic_reference_adapters" as const,
    cases: rows.length,
    baseline: metric("baseline"),
    graph: metric("graph"),
    wrongOwner: rows.reduce((n, r) => n + r.wrongOwner, 0),
    forbiddenHits: rows.reduce((n, r) => n + r.forbiddenHits, 0),
    limitations: [
      "No live Graphiti database, hosted latency, embedding, Walrus readback or action/forecast benefit measured.",
      "Exact event edges do not retrieve global memories; report regressions rather than force promotion.",
      "Development/validation smoke corpus only; no sealed-test tuning.",
    ],
    rows,
  };
}
