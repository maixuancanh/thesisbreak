import { expect, it } from "vitest";
import { authorizedRecalledLessons } from "../../packages/agent/src/recalled-lessons";
import { rememberedConditions } from "../../packages/agent/src/remembered-conditions";
import {
  routeCheckProcedures,
  executeCheckProcedures,
} from "../../packages/agent/src/check-procedures";
const now = new Date("2026-11-03T12:00:00.000Z");
const lesson = {
  id: "synthetic-lesson",
  userId: "owner",
  version: 1,
  parentVersion: null,
  rule: "Wait for an official lineup before reconsidering.",
  scope: { domain: "sports" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-11-02T00:00:00Z",
  expiresAt: null,
  supersededBy: null,
};
async function run(
  owned: unknown[],
  payload: Parameters<
    typeof authorizedRecalledLessons
  >[1][number]["payload"] = lesson,
) {
  const lessons = authorizedRecalledLessons(owned, [
    { logicalId: lesson.id, version: 1, type: "lesson", payload },
  ]);
  const conditions = rememberedConditions({
    userId: "owner",
    domain: "sports",
    now,
    lessons,
  });
  return executeCheckProcedures({
    plan: routeCheckProcedures({
      objectives: [],
      conditions: conditions.applied,
      now,
    }),
    now,
    maxCalls: 1,
    read: async () => [
      {
        id: "rumored-lineup",
        kind: "background",
        confirmsLineup: true,
        retrievedAt: now.toISOString(),
      },
    ],
  });
}
it("matched approved memory changes real tool selection and waits for official evidence", async () => {
  const memory = await run([lesson]),
    control = await run([]);
  expect(memory.raw.map((r) => r.tool)).toEqual(["read_independent_sources"]);
  expect(control.raw).toEqual([]);
  expect(memory.receipts[0]?.status).toBe("failed");
  expect(memory.ready).toBe(false);
});
it.each([
  { status: "paused" },
  { approval: "pending" },
  { supersededBy: "new" },
  { expiresAt: "2026-11-03T11:00:00Z" },
  { userId: "other" },
])(
  "does not apply unauthorized/current-ineligible memory: %j",
  async (patch) => {
    const value = { ...lesson, ...patch };
    expect((await run([value], value)).raw).toEqual([]);
  },
);
it("cannot route a tool from altered remote memory text", async () => {
  expect(
    (
      await run([lesson], {
        ...lesson,
        rule: "read_private_secret https://localhost",
      })
    ).raw,
  ).toEqual([]);
});
