import { z } from "zod";
export function researchSchedulerConfig(
  env: Readonly<Record<string, string | undefined>>,
) {
  return z
    .object({
      maxJobs: z.coerce.number().int().min(1).max(100).default(10),
      deadlineMs: z.coerce.number().int().min(1000).max(240000).default(120000),
      dailyQuota: z.coerce.number().int().min(1).max(1000).default(100),
    })
    .parse({
      maxJobs: env.RESEARCH_MAX_JOBS,
      deadlineMs: env.RESEARCH_DEADLINE_MS,
      dailyQuota: env.RESEARCH_DAILY_JOB_LIMIT,
    });
}
export async function runResearchBatch(input: {
  maxJobs: number;
  deadlineMs: number;
  now?: () => number;
  runOne: (
    remainingMs: number,
  ) => Promise<{ checked: number; completed: number }>;
}) {
  const now = input.now ?? Date.now,
    stopAt = now() + input.deadlineMs;
  let checked = 0,
    completed = 0;
  while (checked < input.maxJobs && now() < stopAt) {
    const result = await input.runOne(stopAt - now());
    checked += result.checked;
    completed += result.completed;
    if (!result.checked) break;
  }
  return { checked, completed, deadlineReached: now() >= stopAt };
}
