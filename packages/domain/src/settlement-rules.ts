import { z } from "zod";

export const ruleCheckSchema = z.object({
  state: z.enum(["available", "missing", "changed"]),
  sourceUrl: z.string().nullable(),
  observedAt: z.string(),
  excerpts: z.array(z.object({
    topic: z.enum(["overtime", "cancellation", "authority", "deadline"]),
    text: z.string().max(1800),
  })).max(8),
  previous: z.object({ pickId: z.string(), version: z.number().int().positive(), recordedAt: z.string() }).nullable(),
  comparison: z.literal("requires_exact_event_outcome_and_rules_review"),
});

/** Excerpts preserve source language. They do not classify ambiguous legal terms. */
export function checkSettlementRules(input: {
  rules: string | null;
  sourceUrl: string | null;
  observedAt: string;
  previous?: { rules: string | null; pickId: string; version: number; recordedAt: string } | null;
}) {
  const rules = input.rules?.trim() ?? "";
  const topics = [
    ["overtime", /\b(overtime|extra time|penalt(?:y|ies)|regulation|90 minutes)\b/i],
    ["cancellation", /\b(postpon\w*|cancel\w*|abandon\w*|void\w*|reschedul\w*)\b/i],
    ["authority", /\b(resolution source|official result|official website|resolved according|settlement source|source of (?:the )?result)\b/i],
    ["deadline", /\b(deadline|ends? at|close[sd]? at)\b|\b(before|by|until)\s+(?:\d+|midnight|noon|kickoff|tip.?off|the (?:start|end)|january|february|march|april|may|june|july|august|september|october|november|december)\b/i],
  ] as const;
  const sentences = rules.split(/(?<=[.!?])\s+|[\r\n]+/).filter(Boolean);
  const excerpts = topics.flatMap(([topic, pattern]) =>
    sentences.filter((text) => text.length <= 1800 && pattern.test(text))
      .slice(0, 2).map((text) => ({ topic, text })),
  );
  const previous = input.previous;
  const changed = previous?.rules != null && previous.rules.trim() !== rules;
  return ruleCheckSchema.parse({
    state: !rules ? "missing" : changed ? "changed" : "available",
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    excerpts,
    previous: previous ? {
      pickId: previous.pickId, version: previous.version, recordedAt: previous.recordedAt,
    } : null,
    comparison: "requires_exact_event_outcome_and_rules_review",
  });
}

type RuleMarket = {
  platform: string;
  eventId?: string | null | undefined;
  rules: string | null;
  closeTime: string | null;
  outcomes: { name: string }[];
};

/** Same wording is only a text observation, never proof of economic equivalence. */
export function compareSettlementRules(a: RuleMarket, b: RuleMarket) {
  const sameEvent = !!a.eventId && !!b.eventId && a.platform === b.platform && a.eventId === b.eventId;
  const sameOutcomes = JSON.stringify(a.outcomes.map((o) => o.name).sort()) === JSON.stringify(b.outcomes.map((o) => o.name).sort());
  const aClose = Date.parse(a.closeTime ?? ""), bClose = Date.parse(b.closeTime ?? "");
  const sameClose = Number.isFinite(aClose) && Number.isFinite(bClose) && aClose === bClose;
  const ruleText = !a.rules?.trim() || !b.rules?.trim()
    ? "unavailable"
    : a.rules.trim() === b.rules.trim() ? "same" : "different";
  return {
    ruleText,
    sameEvent,
    sameOutcomes,
    sameClose,
    equivalence: "not_established" as const,
    label: ruleText === "different" ? "Different rule text" : ruleText === "same" ? "Same rule text · check outcome" : "Rules not supplied",
  };
}
