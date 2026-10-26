import { z } from "zod";
const text = z.string().max(100000);
const recordKey = z.string().regex(/^(Polymarket|Kalshi):[a-z]+:terms-v1$/);
const chatKey = z
  .string()
  .regex(/^(Polymarket|Kalshi):[a-z]+:terms-v1:thread-[1-9][0-9]*$/)
  .refine((value) => Number(value.split("thread-")[1]) <= 1000);
const draftSchema = z
  .object({
    outcome: z.enum(["", "Yes", "No"]),
    reason: text,
    condition: text,
    source: text,
  })
  .strict();
const pickSchema = draftSchema.extend({
  outcome: z.enum(["Yes", "No"]),
  paused: z.boolean(),
  version: z.number().int().positive(),
});
export const previewSchema = z
  .object({
    saved: z.array(recordKey),
    picks: z.record(recordKey, pickSchema),
    forms: z.record(recordKey, draftSchema),
    drafts: z.record(chatKey, text),
    threads: z.record(chatKey, z.array(text)),
    current: z.record(recordKey, z.number().int().min(1).max(1000)),
    lessons: z.array(
      z
        .object({
          id: z.string().min(1),
          text,
          scope: z.enum(["Football", "All future picks"]),
          active: z.boolean(),
        })
        .strict(),
    ),
    decisions: z.array(
      z
        .object({
          at: z.iso.datetime(),
          market: recordKey,
          action: z.enum(["Created pick", "Revised pick"]),
        })
        .strict(),
    ),
  })
  .strict();
export type State = z.infer<typeof previewSchema>;
export type Draft = z.infer<typeof draftSchema>;
export const KEY = "thesisbreak.consumer-preview.v1";
export const empty: State = {
  saved: [],
  picks: {},
  forms: {},
  drafts: {},
  threads: {},
  current: {},
  lessons: [],
  decisions: [],
};
export function parsePreviewState(raw: string): State {
  return previewSchema.parse(JSON.parse(raw));
}

export function serializePreviewState(state: State): string {
  return JSON.stringify(previewSchema.parse(state));
}

/** Pure React updater: invalid proposals never replace the last valid state. */
export function updatePreviewState(
  state: State,
  update: (state: State) => State,
): State {
  const result = previewSchema.safeParse(update(state));
  return result.success ? result.data : state;
}

export function pickDraft(state: State, key: string): Draft {
  const value = state.forms[key] ?? state.picks[key];
  return {
    outcome: value?.outcome ?? "",
    reason: value?.reason ?? "",
    condition: value?.condition ?? "",
    source: value?.source ?? "Official team news (sample preference)",
  };
}

export function savePreviewPick(state: State, key: string, at: string): State {
  const form = pickDraft(state, key);
  if (!form.outcome) return state;
  const previous = state.picks[key];
  const forms = { ...state.forms };
  delete forms[key];
  return {
    ...state,
    forms,
    picks: {
      ...state.picks,
      [key]: {
        ...form,
        outcome: form.outcome,
        paused: previous?.paused ?? false,
        version: (previous?.version ?? 0) + 1,
      },
    },
    decisions: [
      ...state.decisions,
      { at, market: key, action: previous ? "Revised pick" : "Created pick" },
    ],
  };
}

export function knownThreadIds(state: State, marketKey: string): number[] {
  const prefix = `${marketKey}:thread-`;
  const stored = [...Object.keys(state.threads), ...Object.keys(state.drafts)]
    .filter((key) => key.startsWith(prefix))
    .map((key) => Number(key.slice(prefix.length)));
  const max = Math.max(1, state.current[marketKey] ?? 1, ...stored);
  return Array.from({ length: max }, (_, index) => index + 1);
}
