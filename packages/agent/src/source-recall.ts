import {
  authorizedSourceMemories,
  type SourceScore,
} from "../../domain/src/source-credibility";
type RecalledSource = {
  type: string;
  logicalId: string;
  version: number;
  payload: unknown;
};
export async function recallSourceContext(input: {
  userId: string;
  cohort: string;
  loadCurrent: () => Promise<
    { payload: SourceScore; active: boolean; memoryConsent: boolean }[]
  >;
  recall: (query: string) => Promise<{
    records: RecalledSource[];
  }>;
}) {
  const candidates = (await input.loadCurrent())
    .filter(
      (s) =>
        s.active &&
        s.memoryConsent &&
        s.payload.userId === input.userId &&
        s.payload.cohort === input.cohort,
    )
    .slice(0, 4);
  const records: RecalledSource[] = [];
  for (const c of candidates) {
    const found = await input.recall(JSON.stringify(c.payload));
    records.push(...found.records);
  }
  const current = (await input.loadCurrent()).filter((s) => s.memoryConsent);
  return authorizedSourceMemories(current, records, input.userId, input.cohort);
}
