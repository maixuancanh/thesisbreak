import { expect, it } from "vitest";
import { extractExperienceCandidates } from "../../packages/agent/src/experience-extractor";
import { randomUUID, createHash } from "node:crypto";
import { candidateSchema } from "../../packages/domain/src/experience-learning";
const atom = {
  id: randomUUID(),
  origin: "injected_memory",
  reference: "r",
  version: 1,
  hash: createHash("sha256").update("Wait for lineup").digest("hex"),
  text: "Wait for lineup",
  eventId: "e",
  publishedAt: null,
  occurredAt: null,
  retrievedAt: "2026-10-30T00:00:00Z",
  sourceOrigin: "original",
};
it("accepts a structured semantic conflict between distinct atoms and rejects invented related evidence", async () => {
  const experienceId = randomUUID(),
    relatedId = randomUUID(),
    scope = { domain: "sports", eventId: "e" },
    currentAtom = { ...atom, origin: "user_statement" as const };
  const experience = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    eventId: "e",
    modelVersion: "m",
    promptVersion: "p",
    prerequisites: [],
    outcome: null,
    atoms: [currentAtom],
  };
  const ref = {
    atomId: randomUUID(),
    version: 1,
    hash: "b".repeat(64),
    stance: "support" as const,
    quote: "The lineup was not published.",
  };
  const previous = candidateSchema.parse({
    requestId: randomUUID(),
    kind: "source_observation",
    scope,
    statement: "The lineup was not published.",
    experienceIds: [randomUUID()],
    evidence: [ref],
    modelVersion: "m",
    promptVersion: "p",
    condition: null,
  });
  const input = {
    userId: "u",
    experienceId,
    experience,
    scope,
    knownAt: new Date("2026-10-30T06:00:00Z"),
    relatedCandidates: [{ id: relatedId, version: 2, candidate: previous }],
  };
  const generate =
    (bad = false) =>
    async (request: { prompt: string }) => {
      const p = JSON.parse(request.prompt);
      expect(p.relatedCandidates[0].id).toBe(relatedId);
      return {
        candidates: [
          {
            requestId: randomUUID(),
            kind: "source_observation",
            scope,
            statement: "Official lineup is available now.",
            experienceIds: [experienceId],
            evidence: [
              {
                atomId: currentAtom.id,
                version: 1,
                hash: currentAtom.hash,
                stance: "support",
                quote: currentAtom.text,
              },
            ],
            modelVersion: "m",
            promptVersion: "experience-candidate-v1",
            condition: null,
            consolidationProposal: {
              classification: "conflict",
              relatedId,
              relatedVersion: 2,
              relatedEvidence: [
                { ...ref, ...(bad ? { hash: "c".repeat(64) } : {}) },
              ],
            },
          },
        ],
      };
    };
  const valid = await extractExperienceCandidates(input, generate());
  expect(valid.status).toBe("extracted");
  expect(valid.candidates[0]?.consolidationProposal?.classification).toBe(
    "conflict",
  );
  const invalid = await extractExperienceCandidates(input, generate(true));
  expect(invalid.error).toBe("INVALID_CONSOLIDATION_EVIDENCE");
});
it("excludes injected memory before model extraction", async () => {
  let prompt = "";
  const result = await extractExperienceCandidates(
    {
      userId: "u",
      experienceId: randomUUID(),
      scope: { domain: "sports" },
      knownAt: new Date("2026-10-30T06:00:00Z"),
      experience: {
        requestId: randomUUID(),
        sessionId: randomUUID(),
        runId: randomUUID(),
        eventId: "e",
        modelVersion: "m",
        promptVersion: "p",
        prerequisites: [],
        outcome: null,
        atoms: [atom],
      },
    },
    async (r) => {
      prompt = r.prompt;
      return { candidates: [] };
    },
  );
  expect(result.candidates).toEqual([]);
  expect(prompt).not.toContain("Wait for lineup");
});
it("rejects invented references and marks failures explicitly", async () => {
  const result = await extractExperienceCandidates(
    {
      userId: "u",
      experienceId: randomUUID(),
      scope: { domain: "sports" },
      knownAt: new Date("2026-10-30T06:00:00Z"),
      experience: {
        requestId: randomUUID(),
        sessionId: randomUUID(),
        runId: randomUUID(),
        eventId: "e",
        modelVersion: "m",
        promptVersion: "p",
        prerequisites: [],
        outcome: null,
        atoms: [{ ...atom, origin: "user_statement" }],
      },
    },
    async () => ({ candidates: [{}] }),
  );
  expect(result.status).toBe("failed");
  expect(result.error).toBeTruthy();
});
it("refuses incomplete references outside exact originals and rejects cross-event batching", async () => {
  const sessionId = randomUUID(),
    base = {
      requestId: randomUUID(),
      sessionId,
      runId: randomUUID(),
      eventId: "e",
      modelVersion: "m",
      promptVersion: "p",
      prerequisites: [],
      outcome: null,
      atoms: [{ ...atom, origin: "user_statement" }],
    };
  const input = {
    userId: "u",
    experienceId: randomUUID(),
    scope: { domain: "sports", eventId: "e" },
    knownAt: new Date("2026-10-30T06:00:00Z"),
    experience: base,
  };
  const incomplete = await extractExperienceCandidates(input, async () => ({
    candidates: [],
    incomplete: { reason: "missing_critical_context", atomIds: [atom.id] },
  }));
  expect(incomplete.status).toBe("incomplete");
  expect(incomplete.error).toBe("MISSING_CRITICAL_CONTEXT");
  const invented = await extractExperienceCandidates(input, async () => ({
    candidates: [],
    incomplete: { reason: "missing_critical_context", atomIds: [randomUUID()] },
  }));
  expect(invented.status).toBe("failed");
  expect(invented.error).toBe("INVALID_INCOMPLETE_REFERENCE");
  let called = false;
  const foreign = await extractExperienceCandidates(
    {
      ...input,
      additionalExperiences: [
        { id: randomUUID(), experience: { ...base, eventId: "other" } },
      ],
    },
    async () => {
      called = true;
      return { candidates: [] };
    },
  );
  expect(called).toBe(false);
  expect(foreign.error).toBe("INVALID_BATCH_MEMBERSHIP");
});
