import { expect, it } from "vitest";
import { runResearch } from "../../packages/agent/src/runtime";
const now = new Date("2026-11-03T12:00:00Z");
const lesson = { id: "l", userId: "u", version: 1, parentVersion: null, rule: "Wait for an official lineup before reconsidering.", scope: { domain: "sports" }, approval: "approved", status: "active", effectiveAt: "2026-11-02T00:00:00Z", expiresAt: null, supersededBy: null };
const input = { userId: "u", market: { platform: "kalshi" as const, nativeId: "fixture", question: "Fixture only?", outcomes: ["Yes", "No"], rules: "Official fixture rules" }, message: "Review my reason", history: [], domain: "sports", now };
async function run(options: { lessons?: unknown[]; budget?: number; revokeDuringGeneration?: boolean; enabled?: boolean }) {
  let reads = 0, current = true;
  const result = await runResearch(input, {
    ...(options.enabled !== false ? { checkProcedures: { maxCalls: options.budget ?? 1 } } : {}),
    plan: async () => ({ tools: [] }),
    generate: async () => { if (options.revokeDuringGeneration) current = false; return { message: "Fixture answer", evidenceRefs: ["market-source"], lessonRefs: [], proposedChange: null, proposedPick: { outcome: "Yes", reason: "fixture" } }; },
    readPick: async () => null, readLessons: async () => current ? options.lessons ?? [] : [], readComparison: async () => [],
    readIndependent: async () => { reads++; return [{ id: "official", kind: "official_event", confirmsLineup: true, retrievedAt: now.toISOString(), url: "https://official.test", text: "Official fixture lineup" }]; },
    marketSource: { id: "market-source", kind: "market", retrievedAt: now.toISOString(), url: "https://market.test", text: "Fixture rules" },
  });
  return { result, reads };
}
it("approved memory changes actual read behavior with receipts using one cached provider read", async () => {
  const memory = await run({ lessons: [lesson] }), control = await run({ lessons: [] });
  expect(memory.reads).toBe(1); expect(control.reads).toBe(0);
  expect(memory.result.procedureChecks?.receipts[0]).toMatchObject({ status: "passed", evidenceIds: ["official"] });
});
it("missing budget waits without making the required source call", async () => {
  const { result, reads } = await run({ lessons: [lesson], budget: 0 });
  expect(reads).toBe(0);
  expect(result.procedureChecks?.receipts[0]?.status).toBe("not_run");
  expect(result.reply.proposedPick).toBeNull();
});
it("revocation while generating invalidates the prior receipt and proposal", async () => {
  const { result } = await run({ lessons: [lesson], revokeDuringGeneration: true });
  expect(result.procedureChecks?.ready).toBe(false);
  expect(result.procedureChecks?.receipts[0]?.status).toBe("unavailable");
  expect(result.reply.proposedPick).toBeNull();
});
it("feature off preserves legacy source reads and omits procedure receipts", async () => {
  const { result, reads } = await run({ enabled: false });
  expect(reads).toBe(1); expect(result.procedureChecks).toBeUndefined();
});
