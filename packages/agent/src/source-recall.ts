import {
  authorizedSourceMemories,
  type SourceScore,
} from "../../domain/src/source-credibility";
import type { MemoryEnvelope } from "../../integrations/src/memwal";
export async function recallSourceContext(input: {
  userId: string;
  cohort: string;
  loadCurrent: () => Promise<
    { payload: SourceScore; active: boolean; memoryConsent: boolean }[]
  >;
  recall: (
    query: string,
  ) => Promise<{
    records: Pick<
      MemoryEnvelope,
      "type" | "logicalId" | "version" | "payload"
    >[];
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
  const records: Pick<
    MemoryEnvelope,
    "type" | "logicalId" | "version" | "payload"
  >[] = [];
  for (const c of candidates) {
    const found = await input.recall(JSON.stringify(c.payload));
    records.push(...found.records);
  }
  const current = (await input.loadCurrent()).filter((s) => s.memoryConsent);
  return authorizedSourceMemories(current, records, input.userId, input.cohort);
}
