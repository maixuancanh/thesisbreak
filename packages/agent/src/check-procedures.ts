import {
  checkReceiptSchema,
  type CheckReceipt,
} from "../../domain/src/check-procedure";
import {
  evaluateLearningConditions,
  type rememberedConditions,
} from "./remembered-conditions";

export type CheckObjective =
  "official_lineup" | "resolution_rules" | "source_disagreement";
export function explicitCheckObjectives(message: string): CheckObjective[] {
  const objectives: CheckObjective[] = [];
  if (/\b(lineups?|starting five|confirmed starters?)\b/i.test(message))
    objectives.push("official_lineup");
  if (
    /\b(resolution rules?|settlement (?:rules?|conditions?)|market rules?)\b/i.test(
      message,
    )
  )
    objectives.push("resolution_rules");
  if (
    /\b(source disagreement|conflicting (?:reports?|sources?)|sources? disagree)\b/i.test(
      message,
    )
  )
    objectives.push("source_disagreement");
  return objectives;
}
type Condition = ReturnType<typeof rememberedConditions>["applied"][number];
type Source = {
  id: string;
  kind?: string;
  retrievedAt: string;
  publishedAt?: string | null;
  confirmsLineup?: boolean;
  canonicalOriginId?: string | null;
  provenanceRefs?: string[];
  rulesHash?: string | null;
};
export const CHECK_PROCEDURE_REGISTRY = Object.freeze({
  official_lineup: Object.freeze({
    version: "official-lineup-v1",
    tool: "read_independent_sources",
    freshnessSeconds: 900,
    maxToolCalls: 1,
    requiredEvidence: "official_event_confirmed_lineup",
    unsupportedBehavior: "wait",
  }),
  resolution_rules: Object.freeze({
    version: "resolution-rules-v1",
    tool: "read_market",
    freshnessSeconds: 900,
    maxToolCalls: 1,
    requiredEvidence: "market_rules_hash",
    unsupportedBehavior: "report_unsupported",
  }),
  source_disagreement: Object.freeze({
    version: "source-disagreement-v1",
    tool: "read_independent_sources",
    freshnessSeconds: 900,
    maxToolCalls: 1,
    requiredEvidence: "two_independent_origins",
    unsupportedBehavior: "wait",
  }),
});
export type CheckPlan = ReturnType<typeof routeCheckProcedures>;
/** Conditions must come from rememberedConditions over currently authorized records.
 * No memory text, proposed tool name or URL can extend this registry. */
export function routeCheckProcedures(input: {
  objectives: CheckObjective[];
  conditions: Condition[];
  now: Date;
}) {
  const objectives = new Set(
    input.objectives.filter((o) => Object.hasOwn(CHECK_PROCEDURE_REGISTRY, o)),
  );
  const applied = input.conditions.filter(
    (c) =>
      !c.parameters || Date.parse(c.parameters.expiresAt) > input.now.getTime(),
  );
  for (const c of applied) {
    if (
      c.condition === "official_lineup" ||
      c.condition === "require_official_lineup"
    )
      objectives.add("official_lineup");
    if (c.condition === "require_independent_origin")
      objectives.add("source_disagreement");
  }
  const checks = [...objectives].map((kind) => ({
    kind,
    ...CHECK_PROCEDURE_REGISTRY[kind],
    minimumOrigins: Math.max(
      2,
      ...applied
        .filter((c) => c.condition === "require_independent_origin")
        .map((c) => c.parameters?.minimumOrigins ?? 2),
    ),
    dependencies: applied
      .filter((c) =>
        kind === "official_lineup"
          ? ["official_lineup", "require_official_lineup"].includes(c.condition)
          : kind === "source_disagreement" &&
            c.condition === "require_independent_origin",
      )
      .map((c) => ({ id: c.id, version: c.version })),
  }));
  return {
    registryVersion: "check-procedures-v1",
    checks,
    tools: [...new Set(checks.map((c) => c.tool))],
    needsClarification: checks.length === 0,
  };
}

/** Executes read-only checks through caller's existing trace wrappers. Raw reads are
 * retained even when evidence fails; failures never become a successful receipt. */
export async function executeCheckProcedures(input: {
  plan: CheckPlan;
  now: Date;
  maxCalls: number;
  read?: (tool: string) => Promise<Source[]>;
  supportedTools?: readonly string[];
  isCurrent?: () => boolean | Promise<boolean>;
}) {
  const receipts: CheckReceipt[] = [];
  const raw: { tool: string; sources: Source[]; error: string | null }[] = [];
  const maxCalls =
    Number.isInteger(input.maxCalls) && input.maxCalls >= 0
      ? input.maxCalls
      : 0;
  let calls = 0;
  const cache = new Map<string, Source[] | null>();
  for (const check of input.plan.checks) {
    let status: CheckReceipt["status"] = "not_run";
    let evidenceIds: string[] = [];
    const current = async () => {
      try {
        return !input.isCurrent || (await input.isCurrent());
      } catch {
        return false;
      }
    };
    const registered = CHECK_PROCEDURE_REGISTRY[check.kind];
    if (
      !registered ||
      registered.tool !== check.tool ||
      registered.version !== check.version ||
      registered.freshnessSeconds !== check.freshnessSeconds ||
      registered.maxToolCalls !== check.maxToolCalls ||
      registered.requiredEvidence !== check.requiredEvidence ||
      registered.unsupportedBehavior !== check.unsupportedBehavior ||
      !Number.isInteger(check.minimumOrigins) ||
      check.minimumOrigins < 2 ||
      check.minimumOrigins > 5
    )
      status = "unsupported";
    else if (!(await current())) status = "unavailable";
    else if (
      !input.read ||
      (input.supportedTools && !input.supportedTools.includes(check.tool))
    )
      status = "unsupported";
    else if (!cache.has(check.tool) && calls >= maxCalls) status = "not_run";
    else {
      if (!cache.has(check.tool)) {
        calls++;
        try {
          const sources = await input.read(check.tool);
          cache.set(check.tool, sources);
          raw.push({ tool: check.tool, sources, error: null });
        } catch {
          cache.set(check.tool, null);
          raw.push({
            tool: check.tool,
            sources: [],
            error: "READ_UNAVAILABLE",
          });
        }
      }
      const sources = cache.get(check.tool);
      if (!(await current()) || !sources) status = "unavailable";
      else {
        const fresh = sources.filter(
          (s) =>
            s.id &&
            Number.isFinite(Date.parse(s.retrievedAt)) &&
            Date.parse(s.retrievedAt) <= input.now.getTime() &&
            input.now.getTime() - Date.parse(s.retrievedAt) <=
              check.freshnessSeconds * 1000 &&
            (!s.publishedAt ||
              Date.parse(s.publishedAt) <= Date.parse(s.retrievedAt)),
        );
        const relevant =
          check.kind === "official_lineup"
            ? fresh.filter(
                (s) => s.kind === "official_event" && s.confirmsLineup === true,
              )
            : check.kind === "resolution_rules"
              ? fresh.filter(
                  (s) =>
                    s.kind === "market" &&
                    /^[a-f0-9]{64}$/.test(s.rulesHash ?? ""),
                )
              : fresh.filter(
                  (s) => s.canonicalOriginId && s.provenanceRefs?.length,
                );
        const passed =
          check.kind === "official_lineup"
            ? evaluateLearningConditions(
                {
                  requiresLineup: true,
                  requiredTools: ["read_independent_sources"],
                  applied: [
                    {
                      id: "registry",
                      version: 1,
                      condition: "official_lineup",
                    },
                  ],
                },
                { now: input.now, sources: relevant },
              ).ready
            : check.kind === "source_disagreement"
              ? new Set(relevant.map((s) => s.canonicalOriginId)).size >=
                check.minimumOrigins
              : relevant.length > 0;
        status = passed ? "passed" : "failed";
        evidenceIds = relevant.map((s) => s.id);
      }
    }
    receipts.push(
      checkReceiptSchema.parse({
        checkId: check.kind,
        procedureVersionId: check.version,
        tool: check.tool,
        status,
        evidenceIds: [...new Set(evidenceIds)].slice(0, 100),
        checkedAt: input.now.toISOString(),
      }),
    );
  }
  return {
    ready:
      !input.plan.needsClarification &&
      receipts.length > 0 &&
      receipts.every((r) => r.status === "passed" && r.evidenceIds.length > 0),
    receipts,
    raw,
    calls,
  };
}
