import type { Pool } from "pg";
import { storedEventStart } from "./forecast-lock";
import { assessConfirmedAction } from "../../domain/src/action-outcome";
import type { MemoryWriter } from "../../integrations/src/memory-sync";
const iso = (x: Date | string) => new Date(x).toISOString();
export async function listConfirmedActions(
  pool: Pick<Pool, "query">,
  userId: string,
  pickId?: string,
) {
  const rows = (
    await pool.query(
      `SELECT p.id AS pick_id,p.platform,p.native_id,a.id AS proposal_id,a.base_version,a.reason AS decision_reason,b.outcome AS before_outcome,v.outcome AS after_outcome,b.reason AS before_reason,v.reason AS after_reason,v.created_at,s.raw,s.rules_hash,r.payload AS result FROM change_proposals a JOIN picks p ON p.id=a.pick_id AND p.user_id=a.user_id JOIN pick_versions b ON b.pick_id=p.id AND b.user_id=p.user_id AND b.version=a.base_version JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.parent_version=a.base_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id LEFT JOIN LATERAL(SELECT payload FROM confirmed_action_results WHERE pick_id=p.id AND user_id=p.user_id ORDER BY revision DESC LIMIT 1)r ON true WHERE a.user_id=$1 AND ($2::text IS NULL OR p.id=$2) AND a.status='accepted' ORDER BY v.created_at DESC LIMIT 50`,
      [userId, pickId ?? null],
    )
  ).rows;
  return rows.map((r) => {
    const start = storedEventStart(r.raw);
    const assessment = assessConfirmedAction({
      confirmedAt: iso(r.created_at),
      scheduledAt: start,
      rulesMatch: r.result?.rulesHash === r.rules_hash,
      status: r.result?.status ?? "pending",
      observedAt: r.result?.retrievedAt ?? "",
      winner: r.result?.winner ?? null,
      before: r.before_outcome,
      after: r.after_outcome,
    });
    return {
      pickId: r.pick_id,
      proposalId: r.proposal_id,
      platform: r.platform,
      nativeId: r.native_id,
      confirmedAt: iso(r.created_at),
      scheduledAt: start,
      rulesHash: r.rules_hash,
      baseVersion: r.base_version,
      before: { outcome: r.before_outcome, reason: r.before_reason },
      after: { outcome: r.after_outcome, reason: r.after_reason },
      ...assessment,
      sourceUrl:
        assessment.status === "observed_final" ? r.result.sourceUrl : null,
    };
  });
}
/** Trusted public-catalog settlement only; never called with browser/model result fields. */
export async function recordActionSettlement(
  pool: Pool,
  pickId: string,
  input: {
    winner: string | null;
    status: "final" | "pending";
    rulesHash: string;
    sourceUrl: string;
    retrievedAt: string;
  },
) {
  const u = new URL(input.sourceUrl);
  if (
    u.protocol !== "https:" ||
    !["kalshi.com", "external-api.kalshi.com"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw Error("UNVERIFIED_ACTION_SOURCE");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      pickId,
    ]);
    const pick = (
      await c.query(
        "SELECT p.*,clock_timestamp() AS checked_at FROM picks p WHERE p.id=$1 AND p.platform='kalshi'",
        [pickId],
      )
    ).rows[0];
    if (!pick) throw Error("NOT_FOUND");
    if (
      !Number.isFinite(Date.parse(input.retrievedAt)) ||
      Date.parse(input.retrievedAt) > new Date(pick.checked_at).getTime()
    )
      throw Error("FUTURE_RESULT");
    const previous = (
      await c.query(
        "SELECT revision,payload FROM confirmed_action_results WHERE pick_id=$1 ORDER BY revision DESC LIMIT 1",
        [pickId],
      )
    ).rows[0];
    const actions = await listConfirmedActions(c, pick.user_id, pickId);
    if (
      previous &&
      previous.payload.winner === input.winner &&
      previous.payload.status === input.status &&
      previous.payload.rulesHash === input.rulesHash &&
      JSON.stringify(
        previous.payload.actions
          .map((a: { proposalId: string }) => a.proposalId)
          .sort(),
      ) === JSON.stringify(actions.map((a) => a.proposalId).sort())
    ) {
      await c.query("COMMIT");
      return;
    }
    if (!actions.length) {
      await c.query("COMMIT");
      return;
    }
    const payload = {
      userId: pick.user_id,
      pickId,
      platform: pick.platform,
      nativeId: pick.native_id,
      ...input,
      actions: actions.map(
        ({ status, beforeMatched, afterMatched, sourceUrl, ...a }) => {
          void status;
          void beforeMatched;
          void afterMatched;
          void sourceUrl;
          return {
            ...a,
            ...assessConfirmedAction({
              confirmedAt: a.confirmedAt,
              scheduledAt: a.scheduledAt,
              rulesMatch: a.rulesHash === input.rulesHash,
              status: input.status,
              observedAt: input.retrievedAt,
              winner: input.winner,
              before: a.before.outcome,
              after: a.after.outcome,
            }),
          };
        },
      ),
      evidenceLevel: "observational",
      improvementEstablished: false,
    };
    await c.query(
      "INSERT INTO confirmed_action_results(pick_id,user_id,revision,payload) VALUES($1,$2,$3,$4)",
      [
        pickId,
        pick.user_id,
        (previous?.revision ?? 0) + 1,
        JSON.stringify(payload),
      ],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function syncOneActionMemory(
  pool: Pool,
  writer: (owner: string) => MemoryWriter & { destroy: () => void },
) {
  const row = (
    await pool.query(
      `SELECT r.*,r.recorded_at AS time FROM confirmed_action_results r JOIN action_memory_preferences p ON p.user_id=r.user_id AND p.memory_consent=true WHERE r.revision=(SELECT max(revision) FROM confirmed_action_results x WHERE x.pick_id=r.pick_id) AND NOT EXISTS(SELECT 1 FROM action_memory_receipts m WHERE m.pick_id=r.pick_id AND m.revision=r.revision) ORDER BY r.recorded_at LIMIT 1`,
    )
  ).rows[0];
  if (!row) return { checked: 0, verified: 0 };
  const a = writer(row.user_id);
  try {
    const receipt = await a.remember({
      logicalId: `action:${row.pick_id}`,
      type: "action.outcome",
      version: row.revision,
      recordedAt: iso(row.time),
      payload: row.payload,
    });
    if (
      receipt.status !== "verified" ||
      !receipt.blobId ||
      !/^[a-f0-9]{64}$/.test(receipt.hash ?? "")
    )
      return { checked: 1, verified: 0 };
    const permission = (
      await pool.query(
        "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1",
        [row.user_id],
      )
    ).rows[0];
    if (permission?.memory_consent !== true) return { checked: 1, verified: 0 };
    await pool.query(
      "INSERT INTO action_memory_receipts(pick_id,revision,blob_id,hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [row.pick_id, row.revision, receipt.blobId, receipt.hash],
    );
    return { checked: 1, verified: 1 };
  } finally {
    a.destroy();
  }
}
export async function recallActionHistory(
  pool: Pool,
  userId: string,
  recall: (q: string) => Promise<{
    sources: {
      blobId: string;
      record: {
        logicalId: string;
        type: string;
        version: number;
        hash: string;
        payload: unknown;
      };
    }[];
  }>,
) {
  const rows = (
    await pool.query(
      `SELECT r.*,m.blob_id,m.hash FROM confirmed_action_results r JOIN action_memory_receipts m ON m.pick_id=r.pick_id AND m.revision=r.revision JOIN action_memory_preferences p ON p.user_id=r.user_id AND p.memory_consent=true WHERE r.user_id=$1 AND r.revision=(SELECT max(revision) FROM confirmed_action_results x WHERE x.pick_id=r.pick_id) ORDER BY r.recorded_at DESC LIMIT 2`,
      [userId],
    )
  ).rows;
  const accepted: unknown[] = [];
  for (const r of rows) {
    const remote = await recall(JSON.stringify(r.payload));
    const canonical = (v: unknown): string =>
      v && typeof v === "object"
        ? Array.isArray(v)
          ? `[${v.map(canonical).join(",")}]`
          : `{${Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
              .join(",")}}`
        : JSON.stringify(v);
    if (
      remote.sources.some(
        (s) =>
          s.blobId === r.blob_id &&
          s.record.hash === r.hash &&
          s.record.type === "action.outcome" &&
          s.record.logicalId === `action:${r.pick_id}` &&
          s.record.version === r.revision &&
          canonical(s.record.payload) === canonical(r.payload),
      )
    )
      accepted.push(r.payload);
  }
  const permission = (
    await pool.query(
      "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1",
      [userId],
    )
  ).rows[0];
  return permission?.memory_consent === true ? accepted : [];
}
