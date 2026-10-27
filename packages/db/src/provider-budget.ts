import type { Pool } from "pg";

export class ProviderBudgetError extends Error {}
/** Atomic shared daily reservation. Failed/uncertain requests remain charged. */
export async function reserveProviderCredits(
  pool: Pool,
  provider: string,
  cost: number,
  limit: number,
) {
  if (
    !Number.isSafeInteger(cost) ||
    cost <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit < cost ||
    limit > 2147483647
  )
    throw new ProviderBudgetError("PROVIDER_BUDGET_EXHAUSTED");
  const result = await pool.query(
    `INSERT INTO provider_credit_budgets(provider, budget_day, credits, blocked_until)
     SELECT $1,(NOW() AT TIME ZONE 'UTC')::date,$2,NULL
     WHERE NOT EXISTS (SELECT 1 FROM provider_credit_budgets WHERE provider=$1 AND blocked_until > NOW())
     ON CONFLICT(provider,budget_day) DO UPDATE SET credits=provider_credit_budgets.credits+EXCLUDED.credits
     WHERE provider_credit_budgets.credits <= $3-EXCLUDED.credits
       AND (provider_credit_budgets.blocked_until IS NULL OR provider_credit_budgets.blocked_until <= NOW())
     RETURNING credits`,
    [provider, cost, limit],
  );
  if (!result.rows.length)
    throw new ProviderBudgetError("PROVIDER_BUDGET_OR_COOLDOWN");
}
export async function blockProvider(
  pool: Pool,
  provider: string,
  seconds: number,
) {
  const delay = Math.max(
    1,
    Math.min(3600, Math.ceil(Number.isFinite(seconds) ? seconds : 60)),
  );
  await pool.query(
    `INSERT INTO provider_credit_budgets(provider,budget_day,credits,blocked_until)
     VALUES($1,(NOW() AT TIME ZONE 'UTC')::date,0,NOW()+$2*INTERVAL '1 second')
     ON CONFLICT(provider,budget_day) DO UPDATE SET blocked_until=GREATEST(COALESCE(provider_credit_budgets.blocked_until,NOW()),EXCLUDED.blocked_until)`,
    [provider, delay],
  );
}
