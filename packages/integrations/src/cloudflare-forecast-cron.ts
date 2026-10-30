type Env = { FORECAST_CRON_SECRET: string };
export async function triggerForecastTick(
  env: Env,
  transport: typeof fetch = fetch,
) {
  if (!env.FORECAST_CRON_SECRET || env.FORECAST_CRON_SECRET.length < 32)
    throw Error("CRON_UNCONFIGURED");
  const result = await transport(
    "https://thesisbreak.vercel.app/api/internal/forecast-tick",
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
  async scheduled(_event: unknown, env: Env) {
    await triggerForecastTick(env);
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
