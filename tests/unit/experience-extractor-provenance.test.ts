import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  extractExperienceCandidates,
  EXTRACTION_PROMPT_VERSION,
} from "../../packages/agent/src/experience-extractor";
const text = "Wait for the official lineup before changing a pick.";
const atom = {
  id: randomUUID(),
  origin: "user_statement",
  reference: "run:message",
  version: 1,
  hash: createHash("sha256").update(text).digest("hex"),
  text,
  eventId: "event",
  publishedAt: null,
  occurredAt: null,
  retrievedAt: "2026-10-30T00:00:00Z",
  sourceOrigin: "original-user",
};
const experienceId = randomUUID();
const input = {
  userId: "u",
  experienceId,
  scope: { domain: "sports", eventId: "event" },
  knownAt: new Date("2026-10-30T06:00:00Z"),
  experience: {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    eventId: "event",
    modelVersion: "m",
    promptVersion: "p",
    prerequisites: [],
    outcome: null,
    atoms: [atom],
  },
};
const candidate = {
  requestId: randomUUID(),
  kind: "research_procedure",
  scope: input.scope,
  statement: text,
  experienceIds: [experienceId],
  evidence: [
    {
      atomId: atom.id,
      version: 1,
      hash: atom.hash,
      stance: "support",
      quote: text,
    },
  ],
  modelVersion: "m",
  promptVersion: EXTRACTION_PROMPT_VERSION,
  condition: {
    type: "require_official_lineup",
    expiresAt: "2026-11-01T00:00:00Z",
  },
};
it("attributes extraction to its actual model while retaining the source experience model", async () => {
  let sentModel = "";
  const result = await extractExperienceCandidates(
    { ...input, extractionModelVersion: "new-extractor" },
    async (request) => {
      sentModel = JSON.parse(request.prompt).modelVersion;
      return { candidates: [{ ...candidate, modelVersion: "new-extractor" }] };
    },
  );
  expect(sentModel).toBe("new-extractor");
  expect(result.status).toBe("extracted");
  expect(result.candidates[0]?.modelVersion).toBe("new-extractor");
  expect(input.experience.modelVersion).toBe("m");
});
it("extracts a real structured candidate with exact original evidence", async () => {
  expect(
    (
      await extractExperienceCandidates(input, async () => ({
        candidates: [candidate],
      }))
    ).status,
  ).toBe("extracted");
});
it.each([
  { evidence: [{ ...candidate.evidence[0], hash: "b".repeat(64) }] },
  { evidence: [{ ...candidate.evidence[0], quote: "invented quote" }] },
  { experienceIds: [randomUUID()] },
  { statement: "Add 10% probability" },
  { scope: { domain: "politics" } },
])("rejects invalid candidate provenance %j", async (patch) => {
  expect(
    (
      await extractExperienceCandidates(input, async () => ({
        candidates: [{ ...candidate, ...patch }],
      }))
    ).status,
  ).toBe("failed");
});
