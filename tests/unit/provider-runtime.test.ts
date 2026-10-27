import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  reserveProviderCredits,
  blockProvider,
} from "../../packages/db/src/provider-budget";
import { runResearch } from "../../packages/agent/src/runtime";
describe("shared provider budget", () => {
  it("refuses invalid costs before touching the database", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    await expect(reserveProviderCredits(pool, "tatum", 100, 0)).rejects.toThrow(
      "PROVIDER_BUDGET_EXHAUSTED",
    );
    expect(query).not.toHaveBeenCalled();
  });
  it("uses one atomic capped reservation and fails closed on an exhausted budget", async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [] };
    });
    await expect(
      reserveProviderCredits({ query } as unknown as Pool, "tatum", 200, 1000),
    ).rejects.toThrow("PROVIDER_BUDGET_OR_COOLDOWN");
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT");
  });
  it("bounds the shared provider cooldown", async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [] };
    });
    await blockProvider({ query } as unknown as Pool, "tatum", 9000);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("blocked_until"),
      ["tatum", 3600],
    );
  });
});
describe("bounded provider runtime", () => {
  it("keeps 20 evidence sources and reports provider failure without invented evidence", async () => {
    const quote = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const history = vi.fn(async () => [
      {
        id: "tatum-history",
        url: "https://api.tatum.io/history",
        retrievedAt: "2026-10-27T00:00:00Z",
        text: "x".repeat(20000),
      },
    ]);
    const source = {
      id: "market-source",
      url: "https://kalshi.com",
      text: "rules",
      retrievedAt: "2026-10-27T00:00:00Z",
    };
    const generate = vi.fn(async (req) => {
      const prompt = JSON.parse(req.prompt);
      expect(JSON.stringify(prompt).length).toBeLessThan(250000);
      return {
        message: "Observed history",
        evidenceRefs: ["tatum-history"],
        lessonRefs: [],
        proposedChange: null,
      };
    });
    const result = await runResearch(
      {
        userId: "u",
        market: {
          platform: "kalshi",
          nativeId: "TEST",
          question: "A?",
          rules: null,
          outcomes: ["Yes", "No"],
        },
        message: "changes?",
        history: [],
        domain: "test",
        now: new Date(),
      },
      {
        plan: async () => ({
          tools: ["read_tatum_quote", "read_tatum_history", "compare_snapshot"],
        }),
        generate,
        readPick: async () => null,
        readLessons: async () => [],
        readIndependent: async () =>
          Array.from({ length: 30 }, (_, i) => ({ ...source, id: `ind-${i}` })),
        readComparison: async () =>
          Array.from({ length: 30 }, (_, i) => ({ ...source, id: `old-${i}` })),
        marketSource: source,
        readTatumQuote: quote,
        readTatumHistory: history,
      },
    );
    expect(quote).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledOnce();
    expect(result.trace).toContainEqual(
      expect.objectContaining({
        tool: "read_tatum_quote",
        status: "unavailable",
        count: 0,
      }),
    );
    expect(result.sources).toContainEqual(
      expect.objectContaining({ id: "tatum-history" }),
    );
  });
});

it("uses exactly the paired generations for an explicit memory comparison", async () => {
  const generate = vi.fn(async () => ({
    message: "Paired answer",
    evidenceRefs: ["market-source"],
    lessonRefs: [],
    proposedChange: null,
  }));
  const result = await runResearch(
    {
      userId: "u",
      market: {
        platform: "kalshi",
        nativeId: "TEST",
        question: "A?",
        rules: null,
        outcomes: ["Yes", "No"],
      },
      message: "compare",
      history: [{ role: "assistant", text: "prior lesson" }],
      domain: "sports",
      now: new Date("2026-10-27T00:00:00Z"),
      compareMemory: true,
    },
    {
      plan: async () => ({ tools: [] }),
      generate,
      readPick: async () => null,
      readComparison: async () => [],
      readLessons: async () => [
        {
          id: "l",
          userId: "u",
          version: 1,
          parentVersion: null,
          rule: "Check official reports",
          scope: { domain: "sports" },
          approval: "approved",
          status: "active",
          effectiveAt: "2026-10-01T00:00:00Z",
          expiresAt: null,
          supersededBy: null,
        },
      ],
      marketSource: {
        id: "market-source",
        url: "https://kalshi.com",
        text: "rules",
        retrievedAt: "2026-10-27T00:00:00Z",
      },
    },
  );
  expect(generate).toHaveBeenCalledTimes(2);
  expect(result.memoryComparison?.status).toBe("compared");
  expect(result.reply.message).toBe("Paired answer");
  expect(result.reply.proposedChange).toBeNull();
  expect(result.reply.proposedPick).toBeNull();
});
