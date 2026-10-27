import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  assertEventNotStarted,
  assertStoredPickNotStarted,
} from "./forecast-lock";
import {
  DomainConflict,
  validateProposalAcceptance,
} from "../../domain/src/index";
export type Snapshot = {
  platform: string;
  nativeId: string;
  eventId: string | null;
  question: string;
  outcomes: { name: string; price: number | null }[];
  rulesReference: string;
  rulesHash: string;
  closeTime: string | null;
  fetchedAt: string;
  priceAsOf: string | null;
  nativeUnit: string;
  raw: unknown;
};
export type CreatePick = {
  provider?: "auto" | "public" | "tatum";
  platform: string;
  nativeId: string;
  outcome: string;
  reason: string;
  requestId: string;
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function replay(
  client: PoolClient,
  userId: string,
  requestId: string,
  requestHash: string,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([userId, requestId]),
  ]);
  const old = await client.query<{ request_hash: string; result: unknown }>(
    "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
    [userId, requestId],
  );
  if (old.rows[0] && old.rows[0].request_hash !== requestHash)
    throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
  return old.rows[0];
}
async function record(
  client: PoolClient,
  userId: string,
  requestId: string,
  requestHash: string,
  result: unknown,
  kind: string,
  operationKey: string,
) {
  await client.query(
    "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
    [userId, requestId, requestHash, JSON.stringify(result)],
  );
  await client.query(
    "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,$3,$4)",
    [operationKey, userId, kind, JSON.stringify(result)],
  );
}
export function createPick(
  pool: Pool,
  userId: string,
  input: CreatePick,
  resolve: () => Promise<Snapshot>,
) {
  return transaction(pool, async (client) => {
    const requestHash = hash({ kind: "pick.create", ...input });
    const old = await replay(client, userId, input.requestId, requestHash);
    if (old) return old.result;
    const s = await resolve();
    const checkedAt = (
      await client.query("SELECT clock_timestamp() AS checked_at")
    ).rows[0].checked_at;
    assertEventNotStarted(s.raw, new Date(checkedAt));
    if (
      s.platform !== input.platform ||
      s.nativeId !== input.nativeId ||
      !s.outcomes.some((o) => o.name === input.outcome)
    )
      throw new Error("OUTCOME_NOT_IN_MARKET");
    const pickId = randomUUID(),
      snapshotId = randomUUID();
    await client.query(
      "INSERT INTO markets(platform,native_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [s.platform, s.nativeId],
    );
    await client.query(
      "INSERT INTO market_snapshots(id,platform,native_id,event_id,question,outcomes,rules_reference,rules_hash,close_time,fetched_at,price_as_of,native_unit,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        snapshotId,
        s.platform,
        s.nativeId,
        s.eventId,
        s.question,
        JSON.stringify(s.outcomes),
        s.rulesReference,
        s.rulesHash,
        s.closeTime,
        s.fetchedAt,
        s.priceAsOf,
        s.nativeUnit,
        JSON.stringify(s.raw),
      ],
    );
    await client.query(
      "INSERT INTO picks(id,user_id,platform,native_id) VALUES($1,$2,$3,$4)",
      [pickId, userId, s.platform, s.nativeId],
    );
    await client.query(
      "INSERT INTO pick_versions(pick_id,user_id,version,snapshot_id,outcome,reason,assumptions,created_at) VALUES($1,$2,1,$3,$4,$5,'[]',clock_timestamp())",
      [pickId, userId, snapshotId, input.outcome, input.reason],
    );
    const result = { pickId, version: 1 };
    await record(
      client,
      userId,
      input.requestId,
      requestHash,
      result,
      "pick.version.created",
      JSON.stringify(["pick", pickId, 1]),
    );
    return result;
  });
}
export async function readPicks(pool: Pool, userId: string, pickId?: string) {
  const result = await pool.query(
    `SELECT p.id,p.platform,p.native_id,p.current_version,p.state,p.created_at,v.outcome,v.reason,v.assumptions,v.snapshot_id,s.question,s.raw->>'eventTitle' AS event_title,s.raw->>'catalogProvider' AS catalog_provider,s.outcomes,s.rules_reference,s.rules_hash,s.fetched_at,s.price_as_of FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.user_id=$1 ${pickId ? "AND p.id=$2" : ""} ORDER BY p.created_at DESC,p.id DESC LIMIT 100`,
    pickId ? [userId, pickId] : [userId],
  );
  if (pickId && !result.rows[0]) throw new Error("NOT_FOUND");
  return pickId ? result.rows[0] : result.rows;
}
export type ProposePick = {
  baseVersion: number;
  requestId: string;
  changes: { outcome?: string | undefined; reason?: string | undefined };
  reason: string;
};
export function proposePick(
  pool: Pool,
  userId: string,
  pickId: string,
  input: ProposePick,
) {
  return transaction(pool, async (client) => {
    const requestHash = hash({ kind: "pick.propose", pickId, ...input });
    const old = await replay(client, userId, input.requestId, requestHash);
    if (old) return old.result;
    const row = (
      await client.query(
        "SELECT p.current_version,v.outcome,v.reason,s.outcomes FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p",
        [pickId, userId],
      )
    ).rows[0];
    if (!row) throw new Error("NOT_FOUND");
    if (row.current_version !== input.baseVersion)
      throw new DomainConflict("VERSION_CONFLICT");
    await assertStoredPickNotStarted(
      client,
      userId,
      pickId,
      row.current_version,
    );
    if (
      input.changes.outcome &&
      !(row.outcomes as { name: string }[] | null)?.some(
        (o) => o.name === input.changes.outcome,
      )
    )
      throw new Error("OUTCOME_NOT_IN_MARKET");
    const proposalId = randomUUID(),
      expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await client.query(
      "INSERT INTO change_proposals(id,user_id,pick_id,base_version,changes,reason,evidence_refs,expires_at) VALUES($1,$2,$3,$4,$5,$6,'[]',$7)",
      [
        proposalId,
        userId,
        pickId,
        input.baseVersion,
        JSON.stringify(input.changes),
        input.reason,
        expiresAt,
      ],
    );
    const result = {
      proposalId,
      pickId,
      baseVersion: input.baseVersion,
      before: { outcome: row.outcome, reason: row.reason },
      after: {
        outcome: input.changes.outcome ?? row.outcome,
        reason: input.changes.reason ?? row.reason,
      },
      expiresAt,
    };
    await client.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, input.requestId, requestHash, JSON.stringify(result)],
    );
    return result;
  });
}
export function confirmPick(
  pool: Pool,
  userId: string,
  pickId: string,
  input: { proposalId: string; requestId: string; confirmed: true },
) {
  return transaction(pool, async (client) => {
    const requestHash = hash({ kind: "pick.confirm", pickId, ...input });
    const old = await replay(client, userId, input.requestId, requestHash);
    if (old) return old.result;
    // Lock the pick first for a consistent order across proposal creation and acceptance.
    const pick = (
      await client.query(
        "SELECT current_version FROM picks WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [pickId, userId],
      )
    ).rows[0];
    if (!pick) throw new Error("NOT_FOUND");
    const row = (
      await client.query(
        "SELECT * FROM change_proposals WHERE id=$1 AND user_id=$2 AND pick_id=$3 FOR UPDATE",
        [input.proposalId, userId, pickId],
      )
    ).rows[0];
    if (!row) throw new Error("NOT_FOUND");
    const proposal = validateProposalAcceptance(
      {
        id: row.id,
        userId: row.user_id,
        pickId: row.pick_id,
        baseVersion: row.base_version,
        changes: row.changes,
        reason: row.reason,
        evidenceRefs: row.evidence_refs,
        expiresAt: row.expires_at.toISOString(),
        status: row.status,
      },
      { userId, pickId, currentVersion: pick.current_version, now: new Date() },
    );
    const current = (
      await client.query(
        "SELECT * FROM pick_versions WHERE pick_id=$1 AND user_id=$2 AND version=$3",
        [pickId, userId, pick.current_version],
      )
    ).rows[0];
    if (!current) throw new Error("NOT_FOUND");
    await assertStoredPickNotStarted(
      client,
      userId,
      pickId,
      pick.current_version,
    );
    const version = pick.current_version + 1;
    await client.query(
      "INSERT INTO pick_versions(pick_id,user_id,version,parent_version,snapshot_id,outcome,reason,assumptions,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())",
      [
        pickId,
        userId,
        version,
        pick.current_version,
        current.snapshot_id,
        proposal.changes.outcome ?? current.outcome,
        proposal.changes.reason ?? current.reason,
        JSON.stringify(current.assumptions),
      ],
    );
    await client.query(
      "UPDATE picks SET current_version=$1 WHERE id=$2 AND user_id=$3",
      [version, pickId, userId],
    );
    await client.query(
      "UPDATE change_proposals SET status='accepted' WHERE id=$1",
      [proposal.id],
    );
    const result = { pickId, version };
    await record(
      client,
      userId,
      input.requestId,
      requestHash,
      result,
      "pick.version.created",
      JSON.stringify(["pick", pickId, version]),
    );
    return result;
  });
}
