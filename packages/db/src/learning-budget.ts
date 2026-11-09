import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { reserveProviderCredits, ProviderBudgetError } from "./provider-budget";
export const learningBudgetProvider = (owner?: string) =>
  owner
    ? `learning-extraction:owner:${createHash("sha256").update(owner).digest("hex")}`
    : "learning-extraction:global";
/** Units are bounded model attempts, never dollars or claimed measured token usage. */
export async function reserveLearningExtraction(
  pool: Pool,
  input: {
    ownerId: string;
    jobId: string;
    leaseToken: string;
    inputBytes: number;
    maxInputBytes: number;
    maxOutputTokens: number;
    ownerDailyAttempts: number;
    globalDailyAttempts: number;
  },
) {
  if (
    !Number.isSafeInteger(input.inputBytes) ||
    input.inputBytes < 1 ||
    input.inputBytes > input.maxInputBytes
  )
    throw Error("EXTRACTION_INPUT_LIMIT");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const lease = (
      await c.query(
        "SELECT id FROM learning_jobs WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND state='processing' AND lease_until>clock_timestamp() FOR UPDATE",
        [input.ownerId, input.jobId, input.leaseToken],
      )
    ).rows[0];
    if (!lease) throw Error("LEARNING_LEASE_LOST");
    await reserveProviderCredits(
      c,
      learningBudgetProvider(),
      1,
      input.globalDailyAttempts,
    );
    await reserveProviderCredits(
      c,
      learningBudgetProvider(input.ownerId),
      1,
      input.ownerDailyAttempts,
    );
    await c.query(
      "UPDATE learning_jobs SET payload=jsonb_set(payload,'{budgetAttempts}',COALESCE(payload->'budgetAttempts','[]'::jsonb)||jsonb_build_array(jsonb_build_object('reservedAt',clock_timestamp(),'unit','bounded_model_attempt','reservedAttempts',1,'inputBytes',$2::int,'maxInputBytes',$3::int,'maxOutputTokens',$4::int,'ownerDailyLimit',$5::int,'serviceDailyLimit',$6::int))) WHERE id=$1",
      [
        input.jobId,
        input.inputBytes,
        input.maxInputBytes,
        input.maxOutputTokens,
        input.ownerDailyAttempts,
        input.globalDailyAttempts,
      ],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    if (e instanceof ProviderBudgetError)
      throw new ProviderBudgetError("EXTRACTION_BUDGET_DEFERRED");
    throw e;
  } finally {
    c.release();
  }
}
