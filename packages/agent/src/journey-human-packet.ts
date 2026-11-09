import type { Pool } from "pg";
import {
  journeyHash,
  resolveJourneyHumanBinding,
  type ApplicationJourneyFixture,
} from "./application-journey";

/** A packet describes a concrete choice; it never supplies a human decision. */
export async function journeyHumanDecisionPacket(input: {
  pool: Pool;
  runId: string;
  fixture: ApplicationJourneyFixture;
  step: ApplicationJourneyFixture["steps"][number];
  binding: unknown;
  state: { ownerId: string; refs: Record<string, unknown> };
}) {
  const { pool, runId, fixture, step, state } = input;
  const binding = input.binding ?? null;
  const base = {
    caseId: fixture.id,
    stepId: step.id,
    action: step.action,
    binding,
    status: "awaiting_user" as const,
  };
  try {
    const resolvedBinding = await resolveJourneyHumanBinding(
      pool,
      state.ownerId,
      fixture,
      step.action,
      binding,
      state.refs,
    );
    return {
      ...base,
      resolvedBinding,
      actionHash: journeyHash([
        runId,
        fixture.id,
        step.action,
        resolvedBinding,
      ]),
      diagnostic: null,
    };
  } catch (error) {
    return {
      ...base,
      resolvedBinding: null,
      actionHash: null,
      diagnostic:
        error instanceof Error ? error.message : "BINDING_RESOLUTION_FAILED",
    };
  }
}
