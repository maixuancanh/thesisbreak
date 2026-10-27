import { z } from "zod";
const observation = z.object({
  id: z.string().min(1),
  status: z.enum(["observed", "unavailable"]),
  asOf: z.iso.datetime({ offset: true }).nullable(),
  changed: z.boolean(),
});
export function decideResearchReadiness(
  values: z.input<typeof observation>[],
  now: string,
  maxAgeMs = 300000,
) {
  const clock = Date.parse(z.iso.datetime({ offset: true }).parse(now));
  z.number().int().positive().parse(maxAgeMs);
  const checks = z
    .array(observation)
    .max(100)
    .parse(values)
    .map((o) => ({
      id: o.id,
      state:
        o.status === "unavailable"
          ? "unavailable"
          : !o.asOf || Date.parse(o.asOf) > clock
            ? "invalid_timestamp"
            : clock - Date.parse(o.asOf) > maxAgeMs
              ? "stale"
              : o.changed
                ? "observed_change"
                : "observed_no_change",
    }));
  const incomplete =
    !checks.length ||
    checks.some(
      (c) => !["observed_change", "observed_no_change"].includes(c.state),
    );
  return {
    policyVersion: "coverage-v1",
    decision: incomplete
      ? ("wait" as const)
      : checks.some((c) => c.state === "observed_change")
        ? ("review" as const)
        : ("wait" as const),
    reason: incomplete
      ? "incomplete_coverage"
      : checks.some((c) => c.state === "observed_change")
        ? "change_detected"
        : "no_change",
    checkedAt: now,
    checks,
  };
}
