import { replySchema } from "../packages/agent/src/context";
export const researchCases = [
  {
    id: "rumor-is-not-lineup",
    reason: "I expect Alex Sample to start.",
    kind: "background",
    text: "Illustrative fixture: three blogs repeat an unconfirmed claim that Alex Sample starts. No official team sheet.",
    expected: "unclear",
  },
  {
    id: "price-is-not-lineup",
    reason: "I expect Alex Sample to start.",
    kind: "market",
    text: "Illustrative fixture: Yes last-traded price increased from .4 to .7. No player or team news supplied.",
    expected: "unclear",
  },
  {
    id: "official-out-conflict",
    reason: "I expect Alex Sample to start.",
    kind: "official_event",
    text: "Illustrative fixture: official participation report for this exact game lists Alex Sample Out. It does not name the starters.",
    expected: "contradicted",
  },
  {
    id: "official-starter-support",
    reason: "I expect Alex Sample to start.",
    kind: "official_event",
    text: "Illustrative fixture: the official starting team sheet for this exact game explicitly lists Alex Sample as a starter. It does not predict the final outcome.",
    expected: "supported",
  },
] as const;
export function scoreResearchReply(
  test: (typeof researchCases)[number],
  value: unknown,
) {
  const parsed = replySchema.safeParse(value);
  if (!parsed.success) return { reasonCorrect: false, noMutation: false };
  const r = parsed.data,
    claims = r.reasonReview?.claims ?? [];
  // Structural labels on fixed synthetic scenarios, not a free-text quality judge.
  return {
    reasonCorrect:
      claims.length === 1 &&
      claims[0]?.claim === test.reason &&
      claims[0]?.status === test.expected &&
      (test.expected === "unclear" ||
        claims[0]?.evidenceRefs.includes("case-evidence")),
    noMutation: !r.proposedChange && !r.proposedPick,
  };
}
