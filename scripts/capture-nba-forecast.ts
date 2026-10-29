import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { prepareNbaForecast } from "../packages/integrations/src/forecast-pipeline";
import {
  captureNbaForecast,
  listNbaForecastLedger,
} from "../packages/db/src/forecast-ledger";
import { evaluateChronological } from "../packages/domain/src/forecast-model";
const path = process.argv[2];
if (!path)
  throw Error("Provide server-owned input JSON path; no secrets in the input");
const raw = z
  .object({
    userId: z.string().min(1),
    forecast: z.record(z.string(), z.unknown()),
    research: z.unknown(),
  })
  .strict()
  .parse(JSON.parse(readFileSync(path, "utf8")));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const clock = (await pool.query("SELECT clock_timestamp() AS t")).rows[0]
    .t as Date;
  const prepared = prepareNbaForecast({
    ...(raw.research as Parameters<typeof prepareNbaForecast>[0]),
    asOf: clock.toISOString(),
  });
  // All live information must already exist at computation time. Capture validates it again at DB time.
  const saved = await captureNbaForecast(pool, raw.userId, {
    ...raw.forecast,
    namespace: "live",
    modelVersion: "elo-statistical-v1",
    methodVersion: prepared.methodVersion,
    probability: prepared.probability,
    abstentionReason: prepared.abstentionReason,
  } as Parameters<typeof captureNbaForecast>[2]);
  const rows = await listNbaForecastLedger(pool, raw.userId, "live");
  // Separate horizons/methods; never count two forecasts of one game as two events.
  const current = rows.find((r) => r.id === saved.id)!;
  const cohort = rows.filter(
    (r) =>
      r.forecast.horizon === current.forecast.horizon &&
      r.forecast.methodVersion === current.forecast.methodVersion &&
      r.result?.status === "final",
  );
  const report = evaluateChronological(
    cohort.map((r) => ({
      eventId: r.forecast.eventId,
      recordedAt: r.capturedAt,
      scheduledAt: r.forecast.scheduledAt,
      resolvedAt: r.result!.resolvedAt!,
      status: r.result!.status,
      homeWin: r.result!.winner === r.forecast.homeTeam,
      probability: r.forecast.probability,
      baselineProbability: r.forecast.baselineProbability,
    })),
  );
  const out = {
    captured: saved,
    prepared,
    cohort: {
      horizon: current.forecast.horizon,
      methodVersion: current.forecast.methodVersion,
    },
    evaluation: report,
    claim: "No demonstrated predictive improvement",
  };
  writeFileSync(
    ".local/forecast-capture-report.json",
    JSON.stringify(out, null, 2),
  );
  console.log(
    JSON.stringify({
      status: "captured",
      scoredEvents: report.eligibleEvents,
      action: prepared.readiness.action,
    }),
  );
} finally {
  await pool.end();
}
