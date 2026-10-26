import { describe, it, expect } from "vitest";
import {
  cancelRunSchema,
  publicRunState,
  streamRunEvents,
} from "../../packages/db/src/agent-run-control";
describe("durable status stream", () => {
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
