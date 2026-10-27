import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import {
  reserveProviderCredits,
  blockProvider,
} from "../../packages/db/src/provider-budget";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("durable shared provider budgets", () => {
  const pool = new Pool({ connectionString: url });
  const provider = `test-${randomUUID()}`;
  afterAll(async () => {
    await pool.query("DELETE FROM provider_credit_budgets WHERE provider=$1", [
      provider,
    ]);
    await pool.end();
  });
  it("concurrent reservations never exceed the shared limit", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        reserveProviderCredits(pool, provider, 100, 500),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const rows = await pool.query(
      "SELECT credits FROM provider_credit_budgets WHERE provider=$1",
      [provider],
    );
    expect(rows.rows[0].credits).toBe(500);
  });
  it("carries a previous UTC day cooldown across the daily credit reset", async () => {
    await pool.query("DELETE FROM provider_credit_budgets WHERE provider=$1", [
      provider,
    ]);
    await pool.query(
      "INSERT INTO provider_credit_budgets(provider,budget_day,credits,blocked_until) VALUES($1,(NOW() AT TIME ZONE 'UTC')::date-1,500,NOW()+INTERVAL '60 seconds')",
      [provider],
    );
    await expect(
      reserveProviderCredits(pool, provider, 100, 500),
    ).rejects.toThrow("PROVIDER_BUDGET_OR_COOLDOWN");
    await pool.query(
      "UPDATE provider_credit_budgets SET blocked_until=NOW()-INTERVAL '1 second' WHERE provider=$1",
      [provider],
    );
    await reserveProviderCredits(pool, provider, 100, 500);
    const rows = await pool.query(
      "SELECT credits FROM provider_credit_budgets WHERE provider=$1 AND budget_day=(NOW() AT TIME ZONE 'UTC')::date",
      [provider],
    );
    expect(rows.rows[0].credits).toBe(100);
  });
  it("persists a cooldown even if the reservation occurred before UTC midnight", async () => {
    await pool.query("DELETE FROM provider_credit_budgets WHERE provider=$1", [
      provider,
    ]);
    await blockProvider(pool, provider, 60);
    await expect(
      reserveProviderCredits(pool, provider, 100, 500),
    ).rejects.toThrow("PROVIDER_BUDGET_OR_COOLDOWN");
  });
});
