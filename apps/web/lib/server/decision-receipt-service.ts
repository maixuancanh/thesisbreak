import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, AuthError } from "./auth";
import { readDecisionReceipt } from "../../../../packages/db/src/decision-receipt";
import { readProviderProof } from "./provider-proof-service";
let pool: Pool | undefined;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function decisionReceiptOperation(id: string) {
  try {
    const user = await requireUser();
    const runId = z.uuid().parse(id);
    if (!process.env.DATABASE_URL)
      throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
    const db = (pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    }));
    const receipt = await readDecisionReceipt(db, user.id, runId);
    if (receipt) {
      const accountId = process.env.MEMWAL_ACCOUNT_ID;
      const account =
        receipt.publication === "verified" &&
        /^0x[\da-f]{64}$/i.test(accountId ?? "")
          ? await readProviderProof()
          : null;
      return json({
        data: {
          ...receipt,
          suiAccountProof:
            account?.latestProof && accountId
              ? {
                  accountId,
                  checkedAt: account.latestProof.checkedAt,
                  version: account.latestProof.objectVersion,
                  checkpoint: account.latestProof.checkpointHeight,
                }
              : null,
        },
      });
    }
    const ownRun = (
      await db.query("SELECT id FROM agent_runs WHERE user_id=$1 AND id=$2", [
        user.id,
        runId,
      ])
    ).rows[0];
    return ownRun
      ? json({ data: null, status: "not_ready" })
      : json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    if (error instanceof AuthError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: "INVALID_INPUT" }, 400);
    return json({ error: "RECEIPT_UNAVAILABLE" }, 503);
  }
}
