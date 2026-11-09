import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { runForecastChallenger } from "../../packages/integrations/src/forecast-challenger";
import type { ResearchEnvelope } from "../../packages/domain/src/strengthening-contracts";
const text = "Frozen report",
  time = "2026-10-31T00:00:00Z";
const envelope: ResearchEnvelope = {
  schemaVersion: 1,
  jobId: "j",
  ownerId: "o",
  namespace: "evaluation:shadow",
  mode: "synthetic",
  eventId: "e",
  marketId: "m",
  outcomeId: "yes",
  cutoffAt: time,
  eventStartAt: "2026-10-31T02:00:00Z",
  modelVersion: "m",
  procedureVersion: "p",
  maxCalls: 3,
  maxOutputTokens: 900,
  evidence: [
    {
      id: "s",
      sha256: createHash("sha256").update(text).digest("hex"),
      originId: "origin",
      url: "https://example.com",
      observedAt: time,
      publishedAt: null,
      availableAt: time,
      eventId: "e",
    },
  ],
};
const base = {
  envelope,
  artifacts: [{ id: "s", text }],
  now: () => new Date(time),
  reserve: async () => true,
};
it("retains failed attempts and exact evidence while aggregating", async () => {
  let calls = 0;
  const r = await runForecastChallenger({
    ...base,
    generate: async () => {
      if (++calls === 2) throw Error();
      return {
        componentId: "untrusted",
        probability: 0.6,
        status: "ok",
        evidenceIds: ["s"],
        originIds: ["origin"],
        assumptions: [],
        failureCode: null,
      };
    },
  });
  expect(r.attempted).toBe(3);
  expect(r.succeeded).toBe(2);
  expect(r.probability).toBe(0.6);
  expect(r.independentOrigins).toBe(1);
});
it("reserves before dispatch and rejects tampering", async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    return {};
  };
  await expect(
    runForecastChallenger({ ...base, reserve: async () => false, generate }),
  ).rejects.toThrow("BUDGET");
  await expect(
    runForecastChallenger({
      ...base,
      artifacts: [{ id: "s", text: "tampered" }],
      generate,
    }),
  ).rejects.toThrow("HASH");
  expect(calls).toBe(0);
});
it("rejects late completion instead of publishing a retroactive forecast", async () => {
  let now = new Date(time);
  await expect(
    runForecastChallenger({
      ...base,
      now: () => now,
      generate: async () => {
        now = new Date(envelope.eventStartAt);
        throw Error();
      },
    }),
  ).rejects.toThrow("LATE");
});
