import { createHash } from "node:crypto";
import { z } from "zod";
import {
  aggregateForecasts,
  componentForecastSchema,
  researchEnvelopeSchema,
  type ResearchEnvelope,
  type ComponentForecast,
} from "../../domain/src/strengthening-contracts";
const artifactSchema = z
  .object({ id: z.string(), text: z.string().min(1).max(100000) })
  .strict();
/** Shadow-only structured forecast. Evidence content is frozen and verified before any calls. */
export async function runForecastChallenger(input: {
  envelope: ResearchEnvelope;
  artifacts: unknown[];
  now: () => Date;
  generate: (request: {
    role: string;
    envelope: ResearchEnvelope;
    evidence: { id: string; text: string }[];
    maxOutputTokens: number;
    signal: AbortSignal;
  }) => Promise<unknown>;
  reserve: (calls: number, tokens: number) => Promise<boolean>;
}) {
  const envelope = researchEnvelopeSchema.parse(input.envelope);
  const artifacts = input.artifacts.map((a) => artifactSchema.parse(a));
  const refs = new Map(envelope.evidence.map((e) => [e.id, e]));
  if (
    artifacts.length !== refs.size ||
    new Set(artifacts.map((a) => a.id)).size !== refs.size
  )
    throw Error("ARTIFACT_SET_MISMATCH");
  for (const a of artifacts)
    if (
      !refs.has(a.id) ||
      createHash("sha256").update(a.text).digest("hex") !==
        refs.get(a.id)!.sha256
    )
      throw Error("ARTIFACT_HASH_MISMATCH");
  if (input.now().getTime() >= Date.parse(envelope.eventStartAt))
    throw Error("EVENT_ALREADY_STARTED");
  if (
    envelope.maxCalls < 3 ||
    !(await input.reserve(3, envelope.maxOutputTokens))
  )
    throw Error("FORECAST_BUDGET_UNAVAILABLE");
  const components: ComponentForecast[] = [];
  const tokenCap = Math.floor(envelope.maxOutputTokens / 3);
  for (const role of [
    "evidence_research",
    "counter_hypothesis",
    "base_rate_review",
  ]) {
    if (input.now().getTime() >= Date.parse(envelope.eventStartAt))
      throw Error("FORECAST_COMPLETED_LATE");
    try {
      const result = componentForecastSchema.parse(
        await input.generate({
          role,
          envelope,
          evidence: artifacts,
          maxOutputTokens: tokenCap,
          signal: AbortSignal.timeout(20000),
        }),
      );
      if (result.evidenceIds.some((id) => !refs.has(id)))
        throw Error("UNKNOWN_EVIDENCE");
      const origins = new Set(
        result.evidenceIds.map((id) => refs.get(id)!.originId),
      );
      if (result.originIds.some((id) => !origins.has(id)))
        throw Error("UNKNOWN_ORIGIN");
      if (result.status === "ok" && !result.evidenceIds.length)
        throw Error("UNGROUNDED_FORECAST");
      components.push({ ...result, componentId: role });
    } catch {
      components.push({
        componentId: role,
        probability: null,
        status: "failed",
        evidenceIds: [],
        originIds: [],
        assumptions: [],
        failureCode: "COMPONENT_FAILED",
      });
    }
  }
  if (input.now().getTime() >= Date.parse(envelope.eventStartAt))
    throw Error("FORECAST_COMPLETED_LATE");
  return {
    schemaVersion: 1,
    mode: "shadow" as const,
    eventId: envelope.eventId,
    outcomeId: envelope.outcomeId,
    modelVersion: envelope.modelVersion,
    procedureVersion: envelope.procedureVersion,
    evidenceCutoffAt: envelope.cutoffAt,
    completedAt: input.now().toISOString(),
    components,
    ...aggregateForecasts(components),
    predictiveImprovementDemonstrated: false,
  };
}
