import { describe, expect, it } from "vitest";
import {
  routeCheckProcedures,
  executeCheckProcedures,
} from "../../packages/agent/src/check-procedures";
const now = new Date("2026-11-03T12:00:00.000Z");
const source = {
  id: "official-1",
  kind: "official_event",
  retrievedAt: now.toISOString(),
  confirmsLineup: true,
  canonicalOriginId: "official",
};
describe("check procedures", () => {
  it("does not allow a plan to widen registry freshness", async () => {
    const plan = routeCheckProcedures({
      objectives: ["official_lineup"],
      conditions: [],
      now,
    });
    plan.checks[0]!.freshnessSeconds = 86400 as never;
    const result = await executeCheckProcedures({
      plan,
      now,
      maxCalls: 1,
      read: async () => [source],
    });
    expect(result.receipts[0]?.status).toBe("unsupported");
  });
  it("rejects a source published after the recorded retrieval", async () => {
    const plan = routeCheckProcedures({
      objectives: ["official_lineup"],
      conditions: [],
      now,
    });
    const result = await executeCheckProcedures({
      plan,
      now,
      maxCalls: 1,
      read: async () => [
        {
          ...source,
          retrievedAt: "2026-11-03T11:59:00Z",
          publishedAt: now.toISOString(),
        },
      ],
    });
    expect(result.receipts[0]?.status).toBe("failed");
  });
  it("failed current-authority reads are unavailable", async () => {
    const plan = routeCheckProcedures({
      objectives: ["official_lineup"],
      conditions: [],
      now,
    });
    const result = await executeCheckProcedures({
      plan,
      now,
      maxCalls: 1,
      isCurrent: async () => {
        throw Error("DB unavailable");
      },
      read: async () => [source],
    });
    expect(result.receipts[0]?.status).toBe("unavailable");
  });
  it("preserves a stricter approved origin floor", async () => {
    const plan = routeCheckProcedures({
      objectives: [],
      conditions: [
        {
          id: "origin-rule",
          version: 1,
          condition: "require_independent_origin",
          parameters: {
            type: "require_independent_origin",
            minimumOrigins: 3,
            expiresAt: "2026-11-04T12:00:00Z",
          },
        },
      ],
      now,
    });
    const result = await executeCheckProcedures({
      plan,
      now,
      maxCalls: 1,
      read: async () =>
        [1, 2].map((n) => ({
          ...source,
          id: `source-${n}`,
          canonicalOriginId: `origin-${n}`,
          provenanceRefs: [`source-${n}`],
        })),
    });
    expect(result.ready).toBe(false);
  });
  it("rejects a tampered tool before calling the adapter", async () => {
    const plan = routeCheckProcedures({
      objectives: ["official_lineup"],
      conditions: [],
      now,
    });
    plan.checks[0]!.tool = "read_private_secret" as never;
    let calls = 0;
    const result = await executeCheckProcedures({
      plan,
      now,
      maxCalls: 1,
      read: async () => {
        calls++;
        return [source];
      },
    });
    expect(calls).toBe(0);
    expect(result.receipts[0]?.status).toBe("unsupported");
  });
  it("routes multiple explicit objectives without obeying memory tool names", () => {
    const routed = routeCheckProcedures({
      objectives: ["official_lineup", "resolution_rules"],
      conditions: [],
      now,
    });
    expect(routed.tools).toEqual(["read_independent_sources", "read_market"]);
    expect(
      routeCheckProcedures({ objectives: [], conditions: [], now })
        .needsClarification,
    ).toBe(true);
  });
  it("approved conditions alter actual reads and produce evidence receipts", async () => {
    const calls: string[] = [];
    const result = await executeCheckProcedures({
      plan: routeCheckProcedures({
        objectives: [],
        conditions: [
          {
            id: "approved-lesson",
            version: 2,
            condition: "require_official_lineup",
          },
        ],
        now,
      }),
      now,
      maxCalls: 1,
      read: async (tool) => {
        calls.push(tool);
        return [source];
      },
    });
    expect(calls).toEqual(["read_independent_sources"]);
    expect(result.receipts[0]).toMatchObject({
      status: "passed",
      evidenceIds: ["official-1"],
      tool: "read_independent_sources",
    });
    expect(result.ready).toBe(true);
  });
  it("predicted lineup cannot pass official lineup check", async () => {
    const result = await executeCheckProcedures({
      plan: routeCheckProcedures({
        objectives: ["official_lineup"],
        conditions: [],
        now,
      }),
      now,
      maxCalls: 1,
      read: async () => [{ ...source, kind: "background" }],
    });
    expect(result.receipts[0]?.status).toBe("failed");
    expect(result.ready).toBe(false);
  });
  it("distinguishes unsupported, budget exhausted and tool failures", async () => {
    const plan = routeCheckProcedures({
      objectives: ["official_lineup"],
      conditions: [],
      now,
    });
    expect(
      (await executeCheckProcedures({ plan, now, maxCalls: 1 })).receipts[0]
        ?.status,
    ).toBe("unsupported");
    expect(
      (
        await executeCheckProcedures({
          plan,
          now,
          maxCalls: 0,
          read: async () => [source],
        })
      ).receipts[0]?.status,
    ).toBe("not_run");
    expect(
      (
        await executeCheckProcedures({
          plan,
          now,
          maxCalls: 1,
          read: async () => {
            throw Error("offline");
          },
        })
      ).receipts[0]?.status,
    ).toBe("unavailable");
  });
  it("rechecks eligibility after a remote read", async () => {
    let current = true;
    const result = await executeCheckProcedures({
      plan: routeCheckProcedures({
        objectives: ["official_lineup"],
        conditions: [],
        now,
      }),
      now,
      maxCalls: 1,
      isCurrent: () => current,
      read: async () => {
        current = false;
        return [source];
      },
    });
    expect(result.ready).toBe(false);
    expect(result.receipts[0]?.status).toBe("unavailable");
    expect(result.receipts[0]?.evidenceIds).toEqual([]);
  });
});
