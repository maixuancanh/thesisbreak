import { describe, expect, it } from "vitest";
import {
  runEvidenceDebate,
  reviewCaseDebateEvidence,
} from "../../packages/agent/src/evidence-debate";
const at = "2026-10-30T00:00:00Z";
const evidence = [
  {
    id: "s",
    originId: "official",
    eventId: "game",
    availableAt: at,
    sha256: "a".repeat(64),
    text: "lineup uncertain",
  },
];
const input = {
  trigger: "explicit_challenge" as const,
  eventId: "game",
  cutoffAt: at,
  evidence,
  requiredChecks: ["official_lineup"],
  completedChecks: [],
  remainingCalls: 3,
  maxOutputTokens: 600,
};
const side = {
  claims: [
    {
      text: "uncertain",
      evidenceIds: ["s"],
      assumption: "report accurate",
      falsifier: "official correction",
    },
  ],
};
const manager = {
  disposition: "keep",
  supportingIds: ["s"],
  opposingIds: [],
  missingChecks: [],
  explanation: "same report",
};
describe("bounded evidence debate", () => {
  it("reserves budget and never starts on an absent trigger or under three calls", async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      return side;
    };
    expect(
      (await runEvidenceDebate({ ...input, remainingCalls: 2 }, invoke)).status,
    ).toBe("skipped");
    expect(
      (await runEvidenceDebate({ ...input, trigger: null }, invoke)).status,
    ).toBe("skipped");
    expect(calls).toBe(0);
  });
  it("requires checks and counts shared-origin duplicates once", async () => {
    const result = await runEvidenceDebate(
      { ...input, evidence: [...evidence, { ...evidence[0]!, id: "copy" }] },
      async (r) => (r.role === "adjudicator" ? manager : side),
    );
    expect(result.calls).toBe(3);
    expect(result.independentOrigins).toBe(1);
    expect(result.result?.disposition).toBe("insufficient_evidence");
    expect(result.result?.missingChecks).toContain("official_lineup");
  });
  it("does not treat copied reports as verified source disagreement", async () => {
    let calls = 0;
    const result = await runEvidenceDebate(
      {
        ...input,
        trigger: "verified_source_disagreement",
        evidence: [...evidence, { ...evidence[0]!, id: "copy" }],
      },
      async () => {
        calls++;
        return side;
      },
    );
    expect(result.status).toBe("skipped");
    expect(calls).toBe(0);
  });
  it("rejects fabricated citations and does not synthesize consensus", async () => {
    const result = await runEvidenceDebate(input, async (r) =>
      r.role === "support"
        ? { claims: [{ ...side.claims[0], evidenceIds: ["invented"] }] }
        : side,
    );
    expect(result.status).toBe("partial");
    expect(result.calls).toBe(2);
    expect(result.result?.disposition).toBe("insufficient_evidence");
  });
  it("fails closed on timeout and future evidence", async () => {
    const result = await runEvidenceDebate(
      { ...input, timeoutMs: 1 },
      async () => new Promise(() => {}),
    );
    expect(result.status).toBe("partial");
    await expect(
      runEvidenceDebate(
        {
          ...input,
          evidence: [{ ...evidence[0]!, availableAt: "2026-11-01T00:00:00Z" }],
        },
        async () => side,
      ),
    ).rejects.toThrow();
  });
});

it("preserves opposition even when adjudicator omits it", async () => {
  const result = await runEvidenceDebate(
    { ...input, completedChecks: ["official_lineup"] },
    async (r) => (r.role === "adjudicator" ? manager : side),
  );
  const review = reviewCaseDebateEvidence(result);
  expect(review.dissent[0]).toMatchObject({
    statement: "uncertain",
    assumption: "report accurate",
    falsifier: "official correction",
    evidenceIds: ["s"],
  });
  expect(review.strongestObjectionId).toBeNull();
  expect(review.opposingEvidenceIds).toEqual([]);
});

it("retains an explicitly selected cited objection and rejects fabricated selections", async () => {
  const strongestObjection = {
    dissentId: "opposition:1",
    explanation: "It directly challenges the current reason",
    evidenceIds: ["s"],
  };
  const run = (selection: typeof strongestObjection) =>
    runEvidenceDebate(
      { ...input, completedChecks: ["official_lineup"] },
      async (r) =>
        r.role === "adjudicator"
          ? { ...manager, strongestObjection: selection }
          : side,
    );
  const picked = await run(strongestObjection);
  expect(reviewCaseDebateEvidence(picked).strongestObjectionId).toBe(
    "opposition:1",
  );
  expect(
    reviewCaseDebateEvidence(picked).strongestObjectionExplanation,
  ).toContain("current reason");
  const invalid = await run({ ...strongestObjection, dissentId: "invented" });
  expect(invalid.status).toBe("partial");
  expect(reviewCaseDebateEvidence(invalid).strongestObjectionId).toBeNull();
});
