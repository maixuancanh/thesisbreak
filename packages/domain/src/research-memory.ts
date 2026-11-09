import { z } from "zod";
import {
  isLessonApplicable,
  type LessonContext,
  lessonVersionSchema,
} from "./lesson";
export const briefingQuerySchema = z
  .object({
    platform: z.enum(["kalshi", "polymarket"]),
    id: z.string().min(1).max(128),
    provider: z.enum(["public", "tatum"]).default("public"),
  })
  .strict()
  .refine(
    (v) =>
      v.platform === "polymarket"
        ? /^0x[a-fA-F0-9]{64}$/.test(v.id)
        : /^[A-Z][A-Z0-9_.-]{0,127}$/.test(v.id),
    "INVALID_MARKET_ID",
  );
export type BriefingMarket = z.infer<typeof briefingQuerySchema>;
export type LessonVersion = z.infer<typeof lessonVersionSchema>;
export interface LessonHistory {
  currentVersion: number;
  lesson: LessonVersion;
  origin: {
    runId: string;
    platform: string;
    nativeId: string;
    recordedAt: string;
  } | null;
}
export interface ResearchBriefing {
  schemaVersion: 1;
  market: BriefingMarket;
  generatedAt: string;
  contextStatus: "recorded" | "live" | "unavailable";
  currentPick: {
    id: string;
    version: number;
    outcome: string;
    reason: string | null;
    assumptions: unknown[];
    recordedAt: string;
  } | null;
  lastConversation: {
    runId: string;
    message: string;
    reply: string;
    recordedAt: string;
    sources: HabitSource[];
  } | null;
  applicableLessons: LessonHistory[];
  lessonHistory: LessonHistory[];
}
export function selectApplicableLessons<
  T extends { currentVersion: number; lesson: unknown },
>(rows: T[], context: LessonContext): T[] {
  return rows.filter((row) => {
    const p = lessonVersionSchema.safeParse(row.lesson);
    return (
      p.success &&
      p.data.version === row.currentVersion &&
      isLessonApplicable(p.data, context)
    );
  });
}
export interface HabitSource {
  id: string;
  url: string;
  retrievedAt: string;
}
export interface HabitReviewRun {
  userId: string;
  platform: "kalshi" | "polymarket";
  nativeId: string;
  runId: string;
  pickId: string;
  pickVersion: number;
  recordedAt: string;
  claims: {
    claim: string;
    status: "supported" | "contradicted" | "unclear";
    explanation: string;
    evidenceRefs: string[];
  }[];
  sources: HabitSource[];
}
export function aggregateHabits(runs: HabitReviewRun[], userId: string) {
  const groups = new Map<
    string,
    Map<
      string,
      {
        platform: string;
        nativeId: string;
        runId: string;
        pickId: string;
        pickVersion: number;
        recordedAt: string;
        status: string;
        explanation: string;
        sources: HabitSource[];
      }
    >
  >();
  const distinct = new Set<string>();
  for (const run of runs) {
    if (run.userId !== userId) continue;
    const key = JSON.stringify([run.platform, run.nativeId]);
    distinct.add(key);
    for (const claim of run.claims) {
      const normalized = claim.claim
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (!normalized) continue;
      const cases = groups.get(normalized) ?? new Map();
      if (!cases.has(key))
        cases.set(key, {
          platform: run.platform,
          nativeId: run.nativeId,
          runId: run.runId,
          pickId: run.pickId,
          pickVersion: run.pickVersion,
          recordedAt: run.recordedAt,
          status: claim.status,
          explanation: claim.explanation,
          sources: run.sources.filter((s) => claim.evidenceRefs.includes(s.id)),
        });
      groups.set(normalized, cases);
    }
  }
  const patterns = [...groups]
    .filter(([, cases]) => cases.size >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 20)
    .map(([normalizedClaim, cases]) => ({
      normalizedClaim,
      cases: [...cases.values()].slice(0, 20),
    }));
  return {
    schemaVersion: 1 as const,
    status: patterns.length
      ? ("repeated_claims" as const)
      : ("insufficient_history" as const),
    reviewedCases: distinct.size,
    patterns,
    method:
      "Exact normalized repeated claims across distinct recorded markets; review statuses are recorded interpretations, not proof of bad reasoning.",
  };
}
