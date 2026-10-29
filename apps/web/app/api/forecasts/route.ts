import { Pool } from "pg";
import { requireUser, AuthError } from "../../../lib/server/auth";
import { listNbaForecastLedger } from "../../../../../packages/db/src/forecast-ledger";
import { evaluateChronological } from "../../../../../packages/domain/src/forecast-model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let pool: Pool | undefined;
export async function GET() {
  try {
    const user = await requireUser();
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    });
    const rows = await listNbaForecastLedger(pool, user.id, "live");
    const cohorts = [
      ...new Set(
        rows.map((r) => `${r.forecast.horizon}/${r.forecast.methodVersion}`),
      ),
    ].map((key) => {
      const selected = rows.filter(
        (r) =>
          `${r.forecast.horizon}/${r.forecast.methodVersion}` === key &&
          r.result?.status === "final",
      );
      return {
        key,
        metrics: evaluateChronological(
          selected.map((r) => ({
            eventId: r.forecast.eventId,
            recordedAt: r.capturedAt,
            scheduledAt: r.forecast.scheduledAt,
            resolvedAt: r.result!.resolvedAt!,
            status: r.result!.status,
            homeWin: r.result!.winner === r.forecast.homeTeam,
            probability: r.forecast.probability,
            baselineProbability: r.forecast.baselineProbability,
          })),
        ),
      };
    });
    return Response.json(
      { rows, cohorts, improvementDemonstrated: false },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof AuthError ? "SIGN_IN_REQUIRED" : "FORECASTS_UNAVAILABLE",
      },
      { status: e instanceof AuthError ? e.status : 503 },
    );
  }
}
