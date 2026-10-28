import { describe, it, expect } from "vitest";
import {
  cancelRunSchema,
  publicRunState,
  streamRunEvents,
} from "../../packages/db/src/agent-run-control";
import { researchResult } from "../../apps/web/lib/agent-client";
describe("durable status stream", () => {
  it("delivers a source-recall reply through SSE without a false load failure", async () => {
    const source = {
      id: "source-1",
      version: 3,
      sourceName: "Kalshi market quotes",
      kind: "market_baseline",
      cohort: "Sports:NBA",
      performance: { scored: 0, matched: 0, meanBrier: null },
    };
    const result = {
      reply: {
        message: "No final results yet.",
        evidenceRefs: [],
        lessonRefs: [],
        proposedChange: null,
      },
      trace: [{ tool: "recall_source_history", status: "completed", count: 1 }],
      sources: [],
      usedLessons: [],
      pick: null,
      memoryState: "walrus_recalled",
      recalledSources: [source],
      internalSecret: "must not escape",
    };
    const state = publicRunState({ id: "r", status: "completed", result });
    const events: string[] = [];
    await streamRunEvents({
      read: async () => state,
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      lastEventId: "1",
    });
    const event = JSON.parse(events[0]!.split("data: ")[1]!.trim());
    const parsed = researchResult.safeParse(event.result);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.recalledSources).toEqual([source]);
    expect(event.result).not.toHaveProperty("internalSecret");
  });
  it("requires explicit confirmation, UUID and revision", () => {
    expect(
      cancelRunSchema.safeParse({
        confirmed: false,
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      cancelRunSchema.safeParse({
        confirmed: true,
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
        secret: "x",
      }).success,
    ).toBe(false);
  });
  it("hides internal cancellation metadata and failure detail", () => {
    expect(
      publicRunState({
        id: "r",
        status: "failed",
        result: { error: "CANCELLED", cancelRequestId: "secret" },
      }),
    ).toEqual({
      runId: "r",
      status: "failed",
      revision: 2,
      result: { error: "CANCELLED" },
    });
    expect(
      publicRunState({
        id: "r",
        status: "failed",
        result: { error: "password" },
      }).result,
    ).toEqual({ error: "AGENT_UNAVAILABLE" });
  });
  it("resumes from revision 1 and emits terminal revision once", async () => {
    const states = [
      {
        runId: "r",
        status: "running" as const,
        revision: 1 as const,
        result: null,
      },
      {
        runId: "r",
        status: "completed" as const,
        revision: 2 as const,
        result: null,
      },
    ];
    const events: string[] = [];
    await streamRunEvents({
      read: async () => states.shift()!,
      emit: (s) => events.push(s),
      signal: new AbortController().signal,
      lastEventId: "1",
      pollMs: 1,
      maxMs: 100,
    });
    expect(events.filter((s) => s.includes("event: status"))).toHaveLength(1);
    expect(events.join("")).toContain("id: 2");
  });
  it("stops polling immediately when aborted", async () => {
    const controller = new AbortController();
    let reads = 0;
    await streamRunEvents({
      read: async () => {
        reads++;
        controller.abort();
        return { runId: "r", status: "running", revision: 1, result: null };
      },
      emit: () => {},
      signal: controller.signal,
      pollMs: 1,
      maxMs: 100,
    });
    expect(reads).toBe(1);
  });
});

it("preserves verified session provenance and per-turn market identity through resume serialization", () => {
  const sessionId = "916a5c09-1d27-4126-9044-d76558913d50";
  const result = {
    reply: {
      message: "Remembered",
      evidenceRefs: [],
      lessonRefs: [],
      proposedChange: null,
    },
    trace: [{ tool: "recall_conversations", status: "completed", count: 1 }],
    sources: [],
    usedLessons: [],
    pick: null,
    memoryState: "walrus_recalled",
    marketRef: { platform: "kalshi", nativeId: "A" },
    marketQuestion: "A wins?",
    sessionId,
    plannedTools: ["read_tatum_history"],
    sessionMemories: [
      {
        sessionId,
        version: 1,
        blobId: "b",
        recordedAt: "2026-10-28T00:00:00Z",
        payload: { sessionId, title: "Earlier chat", segment: 0, turns: [] },
      },
    ],
  };
  const state = publicRunState({ id: "run", status: "completed", result });
  expect(researchResult.parse(state.result).sessionMemories).toEqual(
    result.sessionMemories,
  );
  expect((state.result as typeof result).marketRef).toEqual(result.marketRef);
});
