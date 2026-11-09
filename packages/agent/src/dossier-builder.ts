import { learningSnapshotHash } from "./learning-provenance";
import { z } from "zod";
import {
  dossierSchema,
  applyDossierPatch,
  type EventDossier,
  type DecisionDependency,
} from "./event-dossier";
import { lessonVersionSchema } from "../../domain/src/lesson";
const source = z
  .object({
    id: z.string(),
    text: z.string().max(12000),
    origin: z.enum(["tool_result", "verified_outcome"]),
    eventId: z.string().nullable(),
    publishedAt: z.iso.datetime({ offset: true }).nullable(),
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
    retrievedAt: z.iso.datetime({ offset: true }),
    sourceOrigin: z.string(),
  })
  .strict();
export const learningRunSchema = z
  .object({
    learningEventId: z.string(),
    learningEvidence: z.array(source).max(20),
    verifiedLearningLessons: z.array(lessonVersionSchema).max(50),
    pick: z
      .object({
        id: z.string(),
        version: z.number().int().positive(),
        outcome: z.string(),
        reason: z.string(),
      })
      .nullable(),
    appliedConditions: z.array(z.unknown()).max(50),
    learningGate: z.object({
      ready: z.boolean(),
      reasons: z.array(z.string()),
    }),
    recalledSources: z.array(z.unknown()).max(4),
    learningSourceMemories: z
      .array(z.object({ id: z.string(), version: z.number() }).passthrough())
      .max(4),
  })
  .passthrough();
const hash = learningSnapshotHash;
function boundedRecords(values: unknown[]) {
  const records: unknown[] = [];
  let omitted = 0;
  for (const value of values) {
    if (
      JSON.stringify({ records: [...records, value], omitted: values.length })
        .length <= 12000
    )
      records.push(value);
    else omitted++;
  }
  return JSON.stringify({
    records,
    omitted,
    originalLookupRequired: omitted > 0,
  });
}
/** Trusted facts only. This materialized view never invents scores or edits confirmed rules. */
export function buildRunDossier(
  userId: string,
  value: unknown,
  checkedAt: string,
): EventDossier {
  const r = learningRunSchema.parse(value);
  const cutoff = Date.parse(checkedAt);
  if (!Number.isFinite(cutoff)) throw Error("INVALID_CHECK_TIME");
  if (
    new Set(r.learningEvidence.map((e) => e.id)).size !==
    r.learningEvidence.length
  )
    throw Error("DUPLICATE_SOURCE");
  for (const e of r.learningEvidence) {
    if (e.eventId !== null && e.eventId !== r.learningEventId)
      throw Error("SOURCE_EVENT_MISMATCH");
    if (
      [e.retrievedAt, e.publishedAt, e.occurredAt].some(
        (t) => t !== null && Date.parse(t) > cutoff,
      )
    )
      throw Error("SOURCE_AFTER_CHECK");
  }
  const lessonDependencies: DecisionDependency[] =
    r.verifiedLearningLessons.map((l) => ({
      id: `lesson:${l.id}`,
      version: l.version,
      hash: hash(l),
      status: "current",
    }));
  const evidenceDependencies: DecisionDependency[] = r.learningEvidence.map(
    (e) => ({
      id: `evidence:${e.id}`,
      version: 1,
      hash: hash(e),
      status: "current",
    }),
  );
  const sourceDependencies: DecisionDependency[] = r.learningSourceMemories.map(
    (m) => ({
      id: `source:${m.id}`,
      version: m.version,
      hash: hash(m),
      status: "current",
    }),
  );
  const pickDependency: DecisionDependency[] = r.pick
    ? [
        {
          id: `pick:${r.pick.id}`,
          version: r.pick.version,
          hash: hash(r.pick),
          status: "current",
        },
      ]
    : [];
  return dossierSchema.parse({
    ownerId: userId,
    eventId: r.learningEventId,
    revision: 1,
    checkedAt,
    blocks: {
      savedView: { text: JSON.stringify(r.pick), dependencies: pickDependency },
      reasons: {
        text: r.pick?.reason ?? "No confirmed saved reason.",
        dependencies: pickDependency,
      },
      conditions: {
        text: JSON.stringify(r.appliedConditions),
        dependencies: lessonDependencies,
      },
      evidence: {
        text: boundedRecords(
          r.learningEvidence.map((e) => ({
            id: e.id,
            text: e.text,
            publishedAt: e.publishedAt,
            retrievedAt: e.retrievedAt,
          })),
        ),
        dependencies: evidenceDependencies,
      },
      unknowns: {
        text: JSON.stringify(r.learningGate),
        dependencies: [...lessonDependencies, ...evidenceDependencies].slice(
          0,
          50,
        ),
      },
      sourceHistory: {
        text: boundedRecords(r.recalledSources),
        dependencies: sourceDependencies,
      },
    },
  });
}
/** Recompute bounded trusted projections, then append only changed mutable blocks.
 * Confirmed view/rules remain protected; changed versions make those blocks stale
 * until a separate confirmed-state update exists. No model-authored patches run here.
 */
export function refreshRunDossier(
  input: unknown,
  userId: string,
  value: unknown,
  checkedAt: string,
) {
  const old = dossierSchema.parse(input),
    next = buildRunDossier(userId, value, checkedAt);
  if (old.ownerId !== userId || old.eventId !== next.eventId)
    throw Error("FORBIDDEN");
  if (Date.parse(checkedAt) < Date.parse(old.checkedAt))
    throw Error("CHECK_TIME_REGRESSION");
  const changes: EventDossier["blocks"] = {};
  const changedBlocks: (keyof EventDossier["blocks"])[] = [];
  for (const key of [
    "reasons",
    "evidence",
    "unknowns",
    "sourceHistory",
  ] as const) {
    if (JSON.stringify(old.blocks[key]) !== JSON.stringify(next.blocks[key])) {
      changes[key] = next.blocks[key];
      changedBlocks.push(key);
    }
  }
  if (changedBlocks.length === 0) return null;
  return {
    changedBlocks,
    dossier: applyDossierPatch(old, {
      ownerId: userId,
      eventId: next.eventId,
      baseRevision: old.revision,
      checkedAt,
      changes,
    }),
  };
}
