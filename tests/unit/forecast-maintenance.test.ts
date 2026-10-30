import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
const mocks = vi.hoisted(() => ({
  results: vi.fn(async () => ({
    checked: 0,
    verified: 0,
    updated: 0,
    unavailable: 0,
  })),
}));
vi.mock("../../packages/integrations/src/forecast-results", () => ({
  refreshNbaForecastResults: mocks.results,
}));
import { runForecastMaintenance } from "../../packages/integrations/src/forecast-maintenance";
it("keeps idle maintenance free of memory writes and fences replay and revoked records", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.includes("RETURNING job") ? [{ job: "nba.maintenance" }] : [],
      };
    },
  } as unknown as Pool;
  const result = await runForecastMaintenance(pool, {});
  expect(result).toMatchObject({
    status: "ok",
    memoriesChecked: 0,
    memoriesVerified: 0,
  });
  expect(mocks.results).toHaveBeenCalledWith(pool, undefined, 2);
  const queue = queries.find((q) => q.includes("SELECT f.id"))!;
  expect(queue).toContain("f.namespace='live'");
  expect(queue).toContain("f.memory_consent=true");
  expect(queue).toContain("s.memory_consent=false");
  expect(queue).toContain("LIMIT 1");
});
