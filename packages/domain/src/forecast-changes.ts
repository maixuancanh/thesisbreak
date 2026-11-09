import { z } from "zod";
const snapshot = z.object({
  eventId: z.string().min(1),
  homeTeam: z.string().min(1),
  methodVersion: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  probability: z.number().min(0).max(1).nullable(),
  evidenceRefs: z.array(z.string()).max(100),
});
/** A traceable change summary; input changes are not causal attribution. */
export function compareForecastCheckpoints(
  before: z.input<typeof snapshot>,
  after: z.input<typeof snapshot>,
) {
  const a = snapshot.parse(before),
    b = snapshot.parse(after);
  if (
    a.eventId !== b.eventId ||
    a.homeTeam !== b.homeTeam ||
    a.methodVersion !== b.methodVersion ||
    Date.parse(a.capturedAt) >= Date.parse(b.capturedAt)
  )
    throw Error("INCOMPARABLE_FORECAST_CHECKPOINTS");
  return {
    beforeAt: a.capturedAt,
    afterAt: b.capturedAt,
    previousProbability: a.probability,
    currentProbability: b.probability,
    percentagePointChange:
      a.probability === null || b.probability === null
        ? null
        : (b.probability - a.probability) * 100,
    newEvidenceRefs: b.evidenceRefs.filter(
      (id) => !a.evidenceRefs.includes(id),
    ),
    causalAttribution: false,
    summary:
      a.probability === null
        ? b.probability === null
          ? "Still waiting for enough evidence."
          : "A probability is now available; the earlier checkpoint was waiting."
        : b.probability === null
          ? "A probability is no longer available; check the missing prerequisites."
          : "The probability changed between recorded checkpoints. Inspect the retained inputs; this alone does not establish why it changed.",
  };
}
