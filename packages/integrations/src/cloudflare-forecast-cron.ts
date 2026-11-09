type Env = {
  FORECAST_CRON_SECRET: string;
  FORECAST_CHALLENGER_MODE?: string;
  FORECAST_CHALLENGER_ENABLED?: string;
  SOURCE_WATCH_ENABLED?: string | undefined;
  SOURCE_WATCH_CRON_SECRET?: string | undefined;
};
/** The endpoint limits each invocation to one due watch under its existing daily budget. */
export async function triggerSourceWatch(
  env: Env,
  transport: typeof fetch = fetch,
) {
  if (env.SOURCE_WATCH_ENABLED !== "true") return;
  if (!env.SOURCE_WATCH_CRON_SECRET || env.SOURCE_WATCH_CRON_SECRET.length < 32)
    throw Error("SOURCE_WATCH_CRON_UNCONFIGURED");
  const response = await transport(
    "https://thesisbreak.vercel.app/api/internal/source-watch-tick",
    {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${env.SOURCE_WATCH_CRON_SECRET}` },
      signal: AbortSignal.timeout(65000),
    },
  );
  await response.body?.cancel();
  if (!response.ok) throw Error(`SOURCE_WATCH_HTTP_${response.status}`);
}
/** Separate invocation keeps the minute capture clock independent of model latency. */
export async function triggerForecastChallenger(
  env: Env,
  transport: typeof fetch = fetch,
) {
  if (
    env.FORECAST_CHALLENGER_MODE !== "shadow" ||
    env.FORECAST_CHALLENGER_ENABLED !== "true"
  )
    return;
  if (!env.FORECAST_CRON_SECRET || env.FORECAST_CRON_SECRET.length < 32)
    throw Error("CRON_UNCONFIGURED");
  const response = await transport(
    "https://thesisbreak.vercel.app/api/internal/forecast-challenger",
    {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${env.FORECAST_CRON_SECRET}` },
      signal: AbortSignal.timeout(125000),
    },
  );
  await response.body?.cancel();
  if (!response.ok) throw Error(`FORECAST_HTTP_${response.status}`);
}
export async function triggerForecastTick(
  env: Env,
  transport: typeof fetch = fetch,
  maintenance = false,
) {
  if (!env.FORECAST_CRON_SECRET || env.FORECAST_CRON_SECRET.length < 32)
    throw Error("CRON_UNCONFIGURED");
  const result = await transport(
    maintenance
      ? "https://thesisbreak.vercel.app/api/internal/forecast-maintenance"
      : "https://thesisbreak.vercel.app/api/internal/forecast-tick",
    {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${env.FORECAST_CRON_SECRET}` },
      signal: AbortSignal.timeout(125000),
    },
  );
  if (!result.ok) {
    await result.body?.cancel();
    throw Error(`FORECAST_HTTP_${result.status}`);
  }
  await result.body?.cancel();
}
export default {
  async scheduled(event: { cron: string }, env: Env) {
    if (event.cron === "3-59/10 * * * *") return triggerSourceWatch(env);
    if (event.cron === "2-59/5 * * * *") return triggerForecastChallenger(env);
    if (event.cron === "*/5 * * * *") {
      // One free-plan clock, separate authenticated server invocations. All are
      // dispatched even if one fails; the minute capture remains independent.
      const outcomes = await Promise.allSettled([
        triggerForecastTick(env, fetch, true),
        triggerForecastChallenger(env),
        triggerSourceWatch(env),
      ]);
      const failures = outcomes.filter((r) => r.status === "rejected");
      if (failures.length) throw Error(`AUXILIARY_WORKERS_FAILED_${failures.length}`);
      return;
    }
    await triggerForecastTick(env);
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
