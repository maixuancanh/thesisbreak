import { expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
const mocks = vi.hoisted(() => ({
  prose: vi.fn(
    async (_pool: Pool, env: Readonly<Record<string, string | undefined>>) => ({
      checked: env.PICK_IMPACT_PROSE_ENABLED === "true" ? 1 : 0,
      completed: env.PICK_IMPACT_PROSE_ENABLED === "true" ? 1 : 0,
    }),
  ),
  learning: vi.fn(async () => ({ checked: 1, completed: 1 })),
  challenge: vi.fn(async () => ({ checked: 1, completed: 1 })),
  receipt: vi.fn(async () => ({ checked: 1, verified: 1 })),
  results: vi.fn(async () => ({
    checked: 1,
    verified: 1,
    updated: 1,
    unavailable: 0,
  })),
  actions: vi.fn(async () => ({ checked: 1 })),
  forecastMemory: vi.fn(async () => ({ status: "verified" })),
  actionMemory: vi.fn(async () => ({ checked: 1, verified: 1 })),
  advice: vi.fn(async () => ({ checked: 0, completed: 0 })),
  dossier: vi.fn(async () => ({ checked: 0, completed: 0 })),
  prepare: vi.fn(async () => ({ checked: 0, completed: 0 })),
  index: vi.fn(async () => ({ checked: 1, indexed: 2 })),
}));
vi.mock("../../packages/integrations/src/claim-challenge-worker", () => ({
 runOneClaimChallengeJob:mocks.challenge,createChallengeVerifier:()=>async()=>({})
}));
vi.mock("../../packages/integrations/src/pick-impact-prose-worker", () => ({
  runOneProsePickImpactJob: mocks.prose,
}));
vi.mock("../../packages/integrations/src/pick-impact-worker", () => ({
  runOnePickImpactJob: async () => ({ checked: 0, completed: 0 }),
}));
vi.mock("../../packages/integrations/src/decision-recap-worker", () => ({
  runOneDecisionRecapJob: async () => ({ checked: 0, completed: 0 }),
}));
vi.mock("../../packages/integrations/src/memory-index-worker", () => ({
  runOneMemoryIndexMaterialization: mocks.index,
}));
vi.mock("../../packages/integrations/src/learning-worker", () => ({
  runOneLearningJob: mocks.learning,
}));
vi.mock("../../packages/integrations/src/receipt-publication-worker", () => ({
  runOneReceiptPublication: mocks.receipt,
}));
vi.mock("../../packages/integrations/src/forecast-results", () => ({
  refreshNbaForecastResults: mocks.results,
}));
vi.mock("../../packages/integrations/src/action-result-worker", () => ({
  refreshOneActionResult: mocks.actions,
}));
vi.mock("../../packages/db/src/forecast-ledger", () => ({
  syncNbaForecastMemory: mocks.forecastMemory,
}));
vi.mock("../../packages/db/src/action-history", () => ({
  syncOneActionMemory: mocks.actionMemory,
}));
vi.mock("../../packages/integrations/src/advice-review-worker", () => ({
  runOneAdviceReviewJob: mocks.advice,
}));
vi.mock("../../packages/integrations/src/event-dossier-worker", () => ({
  runOneEventDossierJob: mocks.dossier,
}));
vi.mock("../../packages/integrations/src/run-receipt-worker", () => ({
  runOneReceiptPreparation: mocks.prepare,
}));
vi.mock("../../packages/integrations/src/decision-receipt-worker", () => ({
  runOneDecisionReceiptPreparation: async () => ({ checked: 0, completed: 0 }),
}));
vi.mock("../../packages/integrations/src/memwal", () => ({
  MemwalAdapter: class {
    destroy() {}
  },
  officialMemwalClient: () => ({}),
  parseMemwalConfig: () => ({}),
}));
import {
  runForecastMaintenance,
  MAINTENANCE_PHASES,
} from "../../packages/integrations/src/forecast-maintenance";
beforeEach(() => vi.clearAllMocks());
it("materializes one local index batch only in shadow or verified rollout", async () => {
  for (const mode of [undefined, "off", "shadow", "verified"]) {
    mocks.index.mockClear();
    const { pool } = database();
    await runForecastMaintenance(
      pool,
      mode ? { GRAPH_RETRIEVAL_MODE: mode } : {},
    );
    expect(mocks.index).toHaveBeenCalledTimes(
      mode === "shadow" || mode === "verified" ? 1 : 0,
    );
  }
});
const remote = () =>
  [
    mocks.learning,
    mocks.receipt,
    mocks.results,
    mocks.actions,
    mocks.forecastMemory,
    mocks.actionMemory,
  ]
    .map((fn) => fn.mock.calls.length)
    .concat(
      mocks.prose.mock.calls.filter(
        ([, env]) => env.PICK_IMPACT_PROSE_ENABLED === "true",
      ).length,
    );
function database(initial = 0, pending = false) {
  let cursor = initial;
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("'nba.maintenance.rotation'")) {
        cursor = (cursor + 1) % MAINTENANCE_PHASES.length;
        return { rows: [{ next: cursor }] };
      }
      if (sql.includes("RETURNING job"))
        return { rows: [{ job: "nba.maintenance" }] };
      if (sql.includes("SELECT f.id"))
        return { rows: pending ? [{ id: "fixture", user_id: "owner" }] : [] };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}
it("runs local materialization and exactly one rotating remote category per invocation", async () => {
  const { pool } = database(0, true);
  for (const phase of MAINTENANCE_PHASES) {
    const before = remote();
    const result = await runForecastMaintenance(pool, {
      PICK_REASON_MONITORING_ENABLED: "true",
      PICK_IMPACT_PROSE_ENABLED: "true",
    });
    expect(result).toMatchObject({ status: "ok", remotePhase: phase });
    const delta = remote().map((n, i) => n - before[i]!);
    expect(delta.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(delta[MAINTENANCE_PHASES.indexOf(phase)]).toBe(1);
  }
  expect(mocks.advice).toHaveBeenCalledTimes(MAINTENANCE_PHASES.length);
  expect(mocks.dossier).toHaveBeenCalledTimes(MAINTENANCE_PHASES.length);
  expect(mocks.prepare).toHaveBeenCalledTimes(MAINTENANCE_PHASES.length);
  expect(mocks.results).toHaveBeenCalledWith(pool, undefined, 1);
});
it("keeps idle forecast-memory phase free of writes and fences replay/revoked records", async () => {
  const { pool, queries } = database(4);
  expect(await runForecastMaintenance(pool, {})).toMatchObject({
    status: "ok",
    remotePhase: "forecast_memory",
    memoriesChecked: 0,
    memoriesVerified: 0,
  });
  expect(remote().reduce((sum, n) => sum + n, 0)).toBe(0);
  const queue = queries.find((q) => q.includes("SELECT f.id"))!;
  expect(queue).toContain("f.namespace='live'");
  expect(queue).toContain("f.memory_consent=true");
  expect(queue).toContain("s.memory_consent=false");
  expect(queue).toContain("LIMIT 1");
});
it("advances durable rotation before failure instead of starving following categories", async () => {
  const { pool } = database();
  mocks.learning.mockRejectedValueOnce(Error("provider unavailable"));
  await expect(runForecastMaintenance(pool, {})).rejects.toThrow(
    "FORECAST_TICK_FAILED",
  );
  expect(await runForecastMaintenance(pool, {})).toMatchObject({
    remotePhase: "receipt",
  });
  expect(mocks.learning).toHaveBeenCalledTimes(1);
  expect(mocks.receipt).toHaveBeenCalledTimes(1);
  expect(mocks.forecastMemory).not.toHaveBeenCalled();
});

it("keeps the prose phase idle unless monitoring and prose execution are both enabled", async () => {
  for (const [monitoring, prose, expected] of [
    ["false", "true", 0],
    ["true", "false", 0],
    ["true", "true", 1],
  ] as const) {
    vi.clearAllMocks();
    const { pool } = database(MAINTENANCE_PHASES.indexOf("pick_impact_prose"));
    const result = await runForecastMaintenance(pool, {
      PICK_REASON_MONITORING_ENABLED: monitoring,
      PICK_IMPACT_PROSE_ENABLED: prose,
    });
    expect(result).toMatchObject({
      status: "ok",
      remotePhase: "pick_impact_prose",
      proseImpacts: { checked: expected, completed: expected },
    });
    expect(remote().reduce((sum, n) => sum + n, 0)).toBe(expected);
    expect(mocks.forecastMemory).not.toHaveBeenCalled();
    expect(mocks.actionMemory).not.toHaveBeenCalled();
  }
});

it("shares the existing learning slot fairly with challenges without a second remote category",async()=>{
 let turn=0,cursor=0;
 const pool={query:async(sql:string)=>{
  if(sql.includes("'nba.maintenance.rotation'")){cursor=(cursor+1)%MAINTENANCE_PHASES.length;return{rows:[{next:cursor}]};}
  if(sql.includes("'nba.maintenance.accountability_learning'")){turn=(turn+1)%2;return{rows:[{next:turn}]};}
  if(sql.includes("RETURNING job"))return{rows:[{job:"nba.maintenance"}]};
  return{rows:[]};
 }} as unknown as Pool;
 for(let i=0;i<2;i++){
  cursor=0;
  const beforeLearning=mocks.learning.mock.calls.length,beforeChallenge=mocks.challenge.mock.calls.length;
  await runForecastMaintenance(pool,{THESISBREAK_ACCOUNTABILITY_ENABLED:"true",SOURCE_WATCH_PUBLISHER_HOSTS:" OFFICIAL.EXAMPLE, publisher.example "});
  expect((mocks.learning.mock.calls.length-beforeLearning)+(mocks.challenge.mock.calls.length-beforeChallenge)).toBe(1);
 }
 expect(MAINTENANCE_PHASES).toHaveLength(7);expect(mocks.challenge).toHaveBeenCalledTimes(1);expect(mocks.learning).toHaveBeenCalledTimes(1);
 expect(mocks.challenge).toHaveBeenCalledWith(pool,expect.objectContaining({hosts:["official.example","publisher.example"],verify:expect.any(Function)}));
});
