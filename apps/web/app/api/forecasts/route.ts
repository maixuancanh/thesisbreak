import { z } from "zod";
import { Pool } from "pg";
import {
  requireUser,
  AuthError,
  assertMutationOrigin,
} from "../../../lib/server/auth";
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
    const subscription = (
      await pool.query(
        "SELECT enabled,memory_consent FROM nba_forecast_subscriptions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0] ?? { enabled: false, memory_consent: false };
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
      { rows, cohorts, subscription, improvementDemonstrated: false },
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

export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const user = await requireUser();
    const text = await request.text();
    if (text.length > 512)
      return Response.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
    const input = z
      .object({ enabled: z.boolean(), memoryConsent: z.boolean() })
      .strict()
      .parse(JSON.parse(text));
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    });
    await pool.query(
      "INSERT INTO nba_forecast_subscriptions(user_id,enabled,memory_consent) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,memory_consent=EXCLUDED.memory_consent,updated_at=clock_timestamp()",
      [user.id, input.enabled, input.memoryConsent],
    );
    return Response.json({ saved: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof AuthError ? e.message : "INVALID_SUBSCRIPTION" },
      { status: e instanceof AuthError ? e.status : 400 },
    );
  }
}
