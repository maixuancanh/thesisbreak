import type { LearningAtom, LearningCandidate } from "./experience-learning";
/** Counts original sources/events, never copies of extracted prose. */
export function learningEvidenceSummary(atoms: LearningAtom[]) {
  const eligible = atoms.filter((a) =>
    ["user_statement", "tool_result", "verified_outcome"].includes(a.origin),
  );
  return {
    originalEvidenceCount: new Set(
      eligible.map(
        (a) => `${a.sourceOrigin}:${a.eventId ?? "unknown"}:${a.hash}`,
      ),
    ).size,
    distinctEventCount: new Set(eligible.map((a) => a.eventId).filter(Boolean))
      .size,
    independentOriginCount: new Set(
      eligible
        .filter(
          (a) =>
            a.origin !== "user_statement" &&
            !/^(?:unknown:|user:|https?:)/i.test(a.sourceOrigin),
        )
        .map((a) => a.sourceOrigin),
    ).size,
  };
}
export function validateCandidateEvidence(
  candidate: LearningCandidate,
  atoms: LearningAtom[],
) {
  const byId = new Map(atoms.map((a) => [`${a.id}:${a.version}`, a]));
  for (const ref of candidate.evidence) {
    const a = byId.get(`${ref.atomId}:${ref.version}`);
    if (!a || a.version !== ref.version || a.hash !== ref.hash)
      throw new Error("INVALID_EVIDENCE_REFERENCE");
    if (
      !["user_statement", "tool_result", "verified_outcome"].includes(a.origin)
    )
      throw new Error("INELIGIBLE_EVIDENCE_ORIGIN");
    if (!a.text.includes(ref.quote)) throw new Error("UNGROUNDED_QUOTE");
    if (candidate.scope.eventId && a.eventId !== candidate.scope.eventId)
      throw new Error("EVIDENCE_SCOPE_MISMATCH");
  }
  return learningEvidenceSummary(
    atoms.filter((a) =>
      candidate.evidence.some(
        (e) => e.atomId === a.id && e.version === a.version,
      ),
    ),
  );
}
