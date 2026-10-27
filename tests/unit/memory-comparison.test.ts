import { describe, expect, it, vi } from "vitest";
import {
  createAgentContext,
  type GenerateReply,
} from "../../packages/agent/src/context";
import { compareMemoryContext } from "../../packages/agent/src/memory-comparison";

const lesson = {
  id: "lesson-a",
  userId: "user-a",
  version: 1,
  parentVersion: null,
  rule: "Check official lineups",
  scope: { domain: "football" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-10-01T00:00:00Z",
  expiresAt: null,
  supersededBy: null,
};
function context(lessons: unknown[] = [lesson]) {
  return createAgentContext({
    userId: "user-a",
    market: {
      platform: "kalshi",
      nativeId: "a",
      question: "Will A win?",
      outcomes: ["Yes", "No"],
      rules: null,
    },
    pick: null,
    evidence: [
      {
        userId: "user-a",
        id: "source-a",
        market: { platform: "kalshi", nativeId: "a" },
        text: "Frozen evidence",
        publishedAt: null,
        retrievedAt: "2026-10-27T00:00:00Z",
      },
    ],
    lessons,
    domain: "football",
    now: new Date("2026-10-27T00:00:00Z"),
  });
}
const reply = {
  message: "Uncertain",
  evidenceRefs: ["source-a"],
  lessonRefs: [],
  proposedChange: null,
};
describe("paired memory comparison", () => {
  it("uses one frozen snapshot and excludes history in both variants", async () => {
    const original = context();
    const prompts: {
      context: ReturnType<typeof context>;
      history: unknown[];
    }[] = [];
    const systems: string[] = [];
    const generate: GenerateReply = async (request) => {
      prompts.push(JSON.parse(request.prompt));
      systems.push(request.system);
      original.evidence[0]!.text = "Changed during generation";
      return {
        ...reply,
        message:
          prompts.length === 1 ? "Consider official lineups" : "Uncertain",
        proposedPick: { outcome: "Yes", reason: "draft" },
      };
    };
    const result = await compareMemoryContext({
      context: original,
      message: "Compare",
      history: [{ role: "assistant", text: "SECRET LESSON INSTRUCTION" }],
      generate,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.history).toEqual([]);
    expect(prompts[1]!.history).toEqual([]);
    expect(prompts[0]!.context.lessons).toHaveLength(1);
    expect(prompts[1]!.context.lessons).toEqual([]);
    expect({ ...prompts[0]!.context, lessons: [] }).toEqual(
      prompts[1]!.context,
    );
    expect(prompts[1]!.context.evidence[0]!.text).toBe("Frozen evidence");
    expect(systems[0]).toBe(systems[1]);
    expect(result.status).toBe("compared");
    expect(result.experimental).toBe(true);
    expect(result.historyPolicy).toBe("excluded_from_both");
    expect(result.changed).toBe(true);
    expect(result.withMemory).not.toHaveProperty("proposedPick");
    expect(result.withMemory).not.toHaveProperty("proposedChange");
    expect(result.lessonVersions).toEqual([{ id: "lesson-a", version: 1 }]);
    expect(result).not.toHaveProperty("score");
    expect(result.note).toContain("not proof");
  });
  it("skips generation without applicable lessons", async () => {
    const generate = vi.fn();
    const result = await compareMemoryContext({
      context: context([]),
      message: "Compare",
      history: [],
      generate,
    });
    expect(result.status).toBe("no_applicable_memory");
    expect(generate).not.toHaveBeenCalled();
    expect(result.withMemory).toBeNull();
    expect(result.changed).toBe(false);
  });
  it("rejects invented citations including lesson citations in baseline", async () => {
    let calls = 0;
    await expect(
      compareMemoryContext({
        context: context(),
        message: "Compare",
        history: [],
        generate: async () => ({
          ...reply,
          lessonRefs: ++calls === 1 ? [] : ["lesson-a"],
        }),
      }),
    ).rejects.toThrow("UNKNOWN_CITATION");
  });
  it("does not treat citations or whitespace alone as changed analysis", async () => {
    let calls = 0;
    const result = await compareMemoryContext({
      context: context(),
      message: "Compare",
      history: [],
      generate: async () => ({
        ...reply,
        message: ++calls === 1 ? "Uncertain  outcome" : " Uncertain outcome ",
        lessonRefs: calls === 1 ? ["lesson-a"] : [],
      }),
    });
    expect(result.changed).toBe(false);
  });
  it("bounds sources before provider use", async () => {
    const value = context();
    value.evidence = Array.from({ length: 21 }, () => value.evidence[0]!);
    const generate = vi.fn();
    await expect(
      compareMemoryContext({
        context: value,
        message: "Compare",
        history: [],
        generate,
      }),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});

it("never supplies future, paused or foreign lessons selected out by the context builder", async () => {
  const generate = vi.fn();
  const value = context([
    { ...lesson, effectiveAt: "2099-01-01T00:00:00Z" },
    { ...lesson, id: "paused", status: "paused" },
    { ...lesson, id: "foreign", userId: "user-b" },
  ]);
  const result = await compareMemoryContext({
    context: value,
    message: "Compare",
    history: [],
    generate,
  });
  expect(result.status).toBe("no_applicable_memory");
  expect(generate).not.toHaveBeenCalled();
});

it("rejects unknown evidence citations and oversized prompts before presenting a pair", async () => {
  await expect(
    compareMemoryContext({
      context: context(),
      message: "Compare",
      history: [],
      generate: async () => ({ ...reply, evidenceRefs: ["made-up"] }),
    }),
  ).rejects.toThrow("UNKNOWN_CITATION");
  const value = context();
  value.evidence = Array.from({ length: 10 }, (_, i) => ({
    ...value.evidence[0]!,
    id: `large-${i}`,
    text: "a".repeat(9000),
  }));
  const generate = vi.fn();
  await expect(
    compareMemoryContext({
      context: value,
      message: "Compare",
      history: [],
      generate,
    }),
  ).rejects.toThrow("CONTEXT_TOO_LARGE");
  expect(generate).not.toHaveBeenCalled();
});

it("strips a validated saved-pick change draft and leaves the saved pick unchanged", async () => {
  const value = context();
  value.pick = {
    userId: "user-a",
    pickId: "pick-a",
    market: { platform: "kalshi", nativeId: "a" },
    version: 1,
    outcome: "Yes",
    reason: "Original reason",
  };
  const result = await compareMemoryContext({
    context: value,
    message: "Draft a change",
    history: [],
    generate: async () => ({
      ...reply,
      proposedChange: { baseVersion: 1, outcome: "No", reason: "Draft reason" },
    }),
  });
  expect(result.withMemory).not.toHaveProperty("proposedChange");
  expect(result.withoutMemory).not.toHaveProperty("proposedChange");
  expect(value.pick.reason).toBe("Original reason");
  expect(value.pick.version).toBe(1);
});
