import { z } from "zod";

export const dependencySchema = z
  .object({
    id: z.string().min(1).max(256),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum([
      "current",
      "false",
      "superseded",
      "revoked",
      "unavailable",
      "broken",
      "pending_consolidation",
    ]),
  })
  .strict();
export type DecisionDependency = z.infer<typeof dependencySchema>;
export const dossierBlockNames = [
  "savedView",
  "reasons",
  "conditions",
  "evidence",
  "unknowns",
  "sourceHistory",
] as const;
const blockSchema = z
  .object({
    text: z.string().max(12000),
    dependencies: z.array(dependencySchema).max(50),
  })
  .strict();
const blocksSchema = z
  .object({
    savedView: blockSchema.optional(),
    reasons: blockSchema.optional(),
    conditions: blockSchema.optional(),
    evidence: blockSchema.optional(),
    unknowns: blockSchema.optional(),
    sourceHistory: blockSchema.optional(),
  })
  .strict();
export const dossierSchema = z
  .object({
    ownerId: z.string().min(1),
    eventId: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    checkedAt: z.iso.datetime(),
    blocks: blocksSchema,
  })
  .strict();
export type EventDossier = z.infer<typeof dossierSchema>;
export function applyDossierPatch(
  input: unknown,
  patchInput: unknown,
): EventDossier {
  const current = dossierSchema.parse(input);
  const patch = z
    .object({
      ownerId: z.string(),
      eventId: z.string(),
      baseRevision: z.number().int(),
      checkedAt: z.iso.datetime(),
      changes: blocksSchema,
    })
    .strict()
    .parse(patchInput);
  if (current.ownerId !== patch.ownerId || current.eventId !== patch.eventId)
    throw Error("FORBIDDEN");
  if (current.revision !== patch.baseRevision) throw Error("REVISION_CONFLICT");
  // Model refreshes cannot rewrite confirmed saved decisions or rule blocks.
  if (patch.changes.savedView || patch.changes.conditions)
    throw Error("PROTECTED_BLOCK");
  if (Date.parse(patch.checkedAt) < Date.parse(current.checkedAt))
    throw Error("CHECK_TIME_REGRESSION");
  return dossierSchema.parse({
    ...current,
    revision: current.revision + 1,
    checkedAt: patch.checkedAt,
    blocks: { ...current.blocks, ...patch.changes },
  });
}
export function dependencyChanged(
  saved: DecisionDependency,
  current: DecisionDependency | undefined,
) {
  return (
    saved.status !== "current" ||
    !current ||
    current.version !== saved.version ||
    current.hash !== saved.hash ||
    current.status !== "current"
  );
}
export function dossierState(
  input: unknown,
  dependencies: DecisionDependency[],
  refresh?: { failed?: boolean },
) {
  const dossier = dossierSchema.parse(input);
  if (refresh?.failed) return "failed_refresh";
  if (Object.keys(dossier.blocks).length === 0) return "empty";
  const latest = new Map(
    dependencies.map((d) => [d.id, dependencySchema.parse(d)]),
  );
  if (
    Object.values(dossier.blocks).some((b) =>
      b?.dependencies.some((d) => dependencyChanged(d, latest.get(d.id))),
    )
  )
    return "stale";
  return dossierBlockNames.every((k) => dossier.blocks[k])
    ? "fresh"
    : "partial";
}
export function affectedDecisions(
  ownerId: string,
  decisions: {
    id: string;
    ownerId: string;
    monitoring: boolean;
    consent: boolean;
    dependencies: DecisionDependency[];
  }[],
  changed: DecisionDependency,
) {
  const dependency = dependencySchema.parse(changed);
  return [
    ...new Set(
      decisions
        .filter(
          (d) =>
            d.ownerId === ownerId &&
            d.monitoring &&
            d.consent &&
            d.dependencies.some(
              (ref) =>
                ref.id === dependency.id && dependencyChanged(ref, dependency),
            ),
        )
        .map((d) => d.id),
    ),
  ];
}
/** Call inside the confirmation transaction after bounded external refresh; provider freshness itself is not atomic. */
export function revalidateDecision(input: {
  expectedPickVersion: number;
  currentPickVersion: number;
  expectedLessonVersion: number | null;
  currentLessonVersion: number | null;
  dependencies: DecisionDependency[];
  currentDependencies: DecisionDependency[];
  consent: boolean;
  now: string;
  eventStartsAt: string | null;
}) {
  const reasons: string[] = [];
  if (!input.consent) reasons.push("CONSENT_REVOKED");
  if (input.expectedPickVersion !== input.currentPickVersion)
    reasons.push("PICK_VERSION_CHANGED");
  if (input.expectedLessonVersion !== input.currentLessonVersion)
    reasons.push("LESSON_VERSION_CHANGED");
  const now = Date.parse(input.now),
    start =
      input.eventStartsAt === null ? NaN : Date.parse(input.eventStartsAt);
  if (!Number.isFinite(now) || !Number.isFinite(start) || now >= start)
    reasons.push("EVENT_STARTED_OR_UNKNOWN");
  const latest = new Map(
    input.currentDependencies.map((d) => [d.id, dependencySchema.parse(d)]),
  );
  for (const raw of input.dependencies) {
    const saved = dependencySchema.parse(raw),
      current = latest.get(saved.id);
    if (!current) reasons.push("DEPENDENCY_BROKEN");
    else if (current.status !== "current")
      reasons.push(`DEPENDENCY_${current.status.toUpperCase()}`);
    else if (dependencyChanged(saved, current))
      reasons.push("DEPENDENCY_CHANGED");
  }
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
