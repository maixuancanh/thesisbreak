/** Internal source originals are persisted for learning, never returned through public chat APIs. */
export function publicAgentResult(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const {
    learningEvidence: _evidence,
    verifiedLearningLessons: _lessons,
    verifiedLearningMemories: _proofs,
    learningSourceMemories: _sources,
    ...rest
  } = value as Record<string, unknown>;
  void _evidence;
  void _lessons;
  void _proofs;
  void _sources;
  return rest;
}
export function publicAgentRuns<T extends { result?: unknown }>(rows: T[]) {
  return rows.map((row) => ({ ...row, result: publicAgentResult(row.result) }));
}
