import { describe, it, expect } from "vitest";
import {
  empty,
  parsePreviewState,
  knownThreadIds,
  pickDraft,
  savePreviewPick,
  serializePreviewState,
  updatePreviewState,
} from "../../apps/web/lib/preview-state";
describe("local preview state boundary", () => {
  it("restores a saved pick after editing its reason without leaking pick fields into drafts", () => {
    const key = "Polymarket:harbor:terms-v1";
    let state = updatePreviewState(empty, (s) => ({
      ...s,
      forms: {
        [key]: { ...pickDraft(s, key), outcome: "Yes", reason: "First view" },
      },
    }));
    state = updatePreviewState(state, (s) =>
      savePreviewPick(s, key, "2026-10-22T04:00:00.000Z"),
    );
    expect(state.picks[key]?.version).toBe(1);
    state = updatePreviewState(state, (s) => ({
      ...s,
      forms: {
        ...s.forms,
        [key]: { ...pickDraft(s, key), reason: "Revised view" },
      },
    }));
    expect(Object.keys(state.forms[key]!)).toEqual([
      "outcome",
      "reason",
      "condition",
      "source",
    ]);
    const restored = parsePreviewState(serializePreviewState(state));
    expect(restored.picks[key]?.reason).toBe("First view");
    expect(restored.forms[key]?.reason).toBe("Revised view");
    const saved = updatePreviewState(restored, (s) =>
      savePreviewPick(s, key, "2026-10-22T05:00:00.000Z"),
    );
    expect(
      parsePreviewState(serializePreviewState(saved)).picks[key],
    ).toMatchObject({ version: 2, reason: "Revised view" });
  });
  it("rejects invalid updates and refuses to serialize malformed runtime state", () => {
    const key = "Polymarket:harbor:terms-v1";
    const malformed = {
      ...empty,
      forms: { [key]: { ...pickDraft(empty, key), paused: false } },
    };
    expect(updatePreviewState(empty, () => malformed)).toBe(empty);
    expect(() => serializePreviewState(malformed)).toThrow();
  });
  it("restores empty state", () =>
    expect(parsePreviewState(JSON.stringify(empty))).toEqual(empty));
  it("rejects corrupt JSON", () =>
    expect(() => parsePreviewState("broken")).toThrow());
  it.each([
    null,
    {},
    { ...empty, picks: [] },
    {
      ...empty,
      lessons: [{ id: "x", text: "x", scope: "unknown", active: true }],
    },
    { ...empty, current: { "Polymarket:harbor:terms-v1": -1 } },
    {
      ...empty,
      picks: {
        "Polymarket:harbor:terms-v1": {
          outcome: "",
          reason: "",
          condition: "",
          source: "",
          paused: false,
          version: 1,
        },
      },
    },
    { ...empty, threads: { "Polymarket:harbor:terms-v1:thread-99999999": [] } },
  ])("rejects malformed persisted shapes %#", (value) =>
    expect(() => parsePreviewState(JSON.stringify(value))).toThrow(),
  );
  it("keeps platform/thread drafts separate", () => {
    const value = {
      ...empty,
      drafts: {
        "Polymarket:harbor:terms-v1:thread-1": "first",
        "Kalshi:harbor:terms-v1:thread-1": "second",
        "Polymarket:harbor:terms-v1:thread-2": "third",
      },
    };
    expect(parsePreviewState(JSON.stringify(value)).drafts).toEqual(
      value.drafts,
    );
  });
  it("keeps an unsent chat selectable after returning to an older chat", () => {
    const key = "Polymarket:harbor:terms-v1";
    const state = {
      ...empty,
      current: { [key]: 1 },
      drafts: {
        [`${key}:thread-2`]: "Unsent thought",
        "Kalshi:harbor:terms-v1:thread-8": "Other platform",
      },
    };
    expect(knownThreadIds(state, key)).toEqual([1, 2]);
    const next = knownThreadIds(state, key).length + 1;
    const after = {
      ...state,
      current: { [key]: next },
      drafts: { ...state.drafts, [`${key}:thread-${next}`]: "" },
    };
    expect(knownThreadIds(after, key)).toEqual([1, 2, 3]);
    expect(after.drafts[`${key}:thread-2`]).toBe("Unsent thought");
    expect(knownThreadIds({ ...after, current: { [key]: 1 } }, key)).toEqual([
      1, 2, 3,
    ]);
  });
});
