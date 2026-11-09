import { availableOfficialLineupTemplates } from "./official-lineup-templates";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  confirmPickReasonSchema,
  reasonConditionSchema,
  type ReasonVersion,
} from "../../domain/src/pick-reason";
import { DomainConflict } from "../../domain/src/index";
export async function monitoringTransaction<T>(
  pool: Pool,
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function monitoringReplay(
  c: PoolClient,
  userId: string,
  requestId: string,
  input: unknown,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${userId}:${requestId}`,
  ]);
  const old = (
    await c.query(
      "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    )
  ).rows[0];
  if (old && old.request_hash !== digest)
    throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
  return { digest, old: old?.result };
}
export async function saveMonitoringRequest(
  c: PoolClient,
  userId: string,
  requestId: string,
  digest: string,
  result: unknown,
) {
  await c.query(
    "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
    [userId, requestId, digest, JSON.stringify(result)],
  );
}
const manualInput = z
  .object({
    kind: z.literal("manual_review"),
    statement: z.string().max(1000).optional(),
    revisitWhen: z.string().trim().min(1).max(1000),
    predicate: z.object({ type: z.literal("manual") }).strict(),
    sourcePolicy: z.literal("manual"),
  })
  .strict();
export const reasonSubmissionSchema = confirmPickReasonSchema.extend({
  conditions: z.array(z.union([reasonConditionSchema, manualInput])).max(4),
});
export async function confirmPickReason(
  pool: Pool,
  userId: string,
  pickId: string,
  raw: unknown,
) {
  const input = reasonSubmissionSchema.parse(raw);
  return monitoringTransaction(pool, userId, async (c) => {
    const replay = await monitoringReplay(c, userId, input.requestId, {
      kind: "pick.reason",
      pickId,
      ...input,
    });
    if (replay.old) return replay.old;
    const p = (
      await c.query(
        "SELECT p.*,v.reason AS pick_reason,s.event_id,s.close_time,EXISTS(SELECT 1 FROM pick_reason_versions r WHERE r.user_id=p.user_id AND r.pick_id=p.id AND r.mode='acceptance_test') AS acceptance_test FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p",
        [pickId, userId],
      )
    ).rows[0];
    if (!p) throw Error("NOT_FOUND");
    if (p.current_version !== input.basePickVersion)
      throw new DomainConflict("STALE_PICK_VERSION");
    const tick = (
      await c.query(
        `SELECT t AS now,to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact FROM (SELECT clock_timestamp() AS t) value`,
      )
    ).rows[0];
    const time = tick.now as Date;
    const eventId = p.event_id ?? `${p.platform}:${p.native_id}`;
    const automaticTemplates = await availableOfficialLineupTemplates(
      c,
      p,
      time,
    );
    const conditions = input.conditions.map((condition) =>
      reasonConditionSchema.parse(
        "subjectId" in condition
          ? condition
          : {
              ...condition,
              statement: condition.statement ?? input.reason.slice(0, 1000),
              subjectId: eventId,
              eventIds: [eventId],
              validFrom: time.toISOString(),
              validUntil: new Date(
                Math.max(
                  time.getTime() + 86400000,
                  p.close_time ? new Date(p.close_time).getTime() : 0,
                ),
              ).toISOString(),
            },
      ),
    );
    for (const condition of conditions)
      if (!condition.eventIds.includes(eventId))
        throw Error("CONDITION_EVENT_MISMATCH");
    const revision = (
      await c.query(
        "SELECT COALESCE(max(revision),0)+1 AS n FROM pick_reason_versions WHERE user_id=$1 AND pick_id=$2 AND pick_version=$3",
        [userId, pickId, p.current_version],
      )
    ).rows[0].n;
    const reason: ReasonVersion = {
      id: randomUUID(),
      ownerId: userId,
      pickId,
      pickVersion: p.current_version,
      revision,
      userText: input.reason,
      conditions,
      confirmedAt: tick.exact,
      evidenceRefs: [],
      mode:
        p.acceptance_test === true ||
        /^Acceptance test only:/i.test(String(p.pick_reason ?? "").trim()) ||
        /^Acceptance test only:/i.test(input.reason.trim())
          ? "acceptance_test"
          : "live",
    };
    await c.query(
      "INSERT INTO pick_reason_versions(id,user_id,pick_id,pick_version,revision,payload,confirmed_at,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        reason.id,
        userId,
        pickId,
        p.current_version,
        revision,
        JSON.stringify(reason),
        reason.confirmedAt,
        reason.mode,
      ],
    );
    await c.query(
      "UPDATE pick_watch_bindings b SET state='paused' FROM pick_reason_versions r WHERE b.reason_id=r.id AND b.user_id=$1 AND r.pick_id=$2",
      [userId, pickId],
    );
    const consent =
      (
        await c.query(
          "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1 FOR SHARE",
          [userId],
        )
      ).rows[0]?.memory_consent === true;
    let bindingCount = 0;
    const unsupportedConditions: string[] = [];
    for (const [index, condition] of conditions.entries()) {
      if (!input.enableMonitoring) continue;
      if (!consent) {
        unsupportedConditions.push(
          "Monitoring requires consent; your reason was saved without monitoring.",
        );
        continue;
      }
      let watches: { id: string }[] = [];
      if (condition.predicate.type === "source_revision")
        watches = (
          await c.query(
            "SELECT id FROM source_watches WHERE user_id=$1 AND event_id=$2 AND dependency_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR SHARE",
            [userId, eventId, condition.predicate.referenceId],
          )
        ).rows;
      else if (condition.predicate.type === "lineup_status")
        watches = (
          await c.query(
            "SELECT id FROM source_watches WHERE user_id=$1 AND event_id=$2 AND state='active' AND expires_at>clock_timestamp() AND structured_evidence->>'subjectId'=$3 AND structured_evidence->>'adapterVersion'='nba-official-lineup-v1' AND structured_evidence->>'official'='true' FOR SHARE",
            [userId, eventId, condition.subjectId],
          )
        ).rows;
      else {
        unsupportedConditions.push(
          condition.kind === "manual_review"
            ? "Manual condition: review it yourself."
            : "No verified source adapter is configured for this condition.",
        );
        continue;
      }
      if (condition.predicate.type === "lineup_status" && !watches.length) {
        const template = automaticTemplates.find(
          (t) =>
            t.condition.subjectId === condition.subjectId &&
            t.condition.eventIds.includes(eventId),
        );
        if (template) {
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`source-watch:${userId}`],
          );
          const count = (
            await c.query(
              "SELECT count(*)::int AS n FROM source_watches WHERE user_id=$1 AND state<>'deleted' AND expires_at>clock_timestamp()",
              [userId],
            )
          ).rows[0].n;
          if (count >= 5) throw new DomainConflict("SOURCE_WATCH_CAP");
          const watchId = randomUUID();
          const value = JSON.stringify({
            gameId: template.target.target.gameId,
            personId: template.target.personId,
            lineupStatus: "starter",
          });
          const meta = {
            subjectId: condition.subjectId,
            eventId,
            official: true,
            lineupStatus: "starter",
            sourceUrl: template.sourceUrl,
            sourceHash: template.sourceHash,
            adapterVersion: "nba-official-lineup-v1",
          };
          await c.query(
            "INSERT INTO source_watches(id,user_id,event_id,url,origin_id,content_class,selector,dependency_id,hypothesis_version,expires_at,poll_seconds,snapshot_hash,snapshot_value,structured_evidence,official_target) VALUES($1,$2,$3,$4,'nba_official','json','official-player-lineup',$5,1,$6,300,$7,$8,$9,$10)",
            [
              watchId,
              userId,
              eventId,
              template.sourceUrl,
              `official-lineup:${template.target.target.gameId}:${template.target.personId}`,
              template.condition.validUntil,
              createHash("sha256").update(value).digest("hex"),
              value,
              JSON.stringify(meta),
              JSON.stringify(template.target),
            ],
          );
          watches = [{ id: watchId }];
        }
      }
      for (const w of watches) {
        await c.query(
          "INSERT INTO pick_watch_bindings(id,user_id,reason_id,watch_id,condition_index) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), userId, reason.id, w.id, index],
        );
        bindingCount++;
      }
      if (!watches.length)
        unsupportedConditions.push(
          "No eligible watched source is available for this condition.",
        );
    }
    const result = {
      basePickVersion: p.current_version,
      reason,
      monitoring: {
        enabled: bindingCount > 0,
        bindingCount,
        unsupportedConditions,
      },
    };
    await c.query(
      "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'decision_recap',$3,$4) ON CONFLICT DO NOTHING",
      [randomUUID(), userId, `reason:${reason.id}`, JSON.stringify({ pickId })],
    );
    await saveMonitoringRequest(
      c,
      userId,
      input.requestId,
      replay.digest,
      result,
    );
    return result;
  });
}
export async function readPickReason(
  pool: Pool,
  userId: string,
  pickId: string,
) {
  return monitoringTransaction(pool, userId, async (c) => {
    const pick = (
      await c.query(
        "SELECT p.current_version,p.platform,p.native_id,s.event_id,s.close_time,clock_timestamp() AS now FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.id=$1 AND p.user_id=$2",
        [pickId, userId],
      )
    ).rows[0];
    if (!pick) throw Error("NOT_FOUND");
    const eventId = pick.event_id ?? `${pick.platform}:${pick.native_id}`;
    const watches = (
      await c.query(
        "SELECT id,url,dependency_id,expires_at,structured_evidence FROM source_watches WHERE user_id=$1 AND event_id=$2 AND state='active' AND expires_at>clock_timestamp() LIMIT 25",
        [userId, eventId],
      )
    ).rows;
    const availableConditions = watches
      .filter(
        (w) =>
          w.structured_evidence?.adapterVersion ===
          "reviewed-report-revision-v1",
      )
      .map((w) => ({
        id: w.id,
        label: `Watch report from ${new URL(w.url).hostname}`,
        condition: {
          kind: "source_correction",
          subjectId: w.structured_evidence.subjectId,
          eventIds: [eventId],
          statement: "This report supports my reason.",
          revisitWhen: "This source publishes a correction.",
          predicate: {
            type: "source_revision",
            referenceId: w.dependency_id,
            revisitOn: "corrected",
          },
          sourcePolicy: "reviewed_primary",
          validFrom: new Date(pick.now).toISOString(),
          validUntil: new Date(w.expires_at).toISOString(),
        },
      }));
    for (const w of watches) {
      const meta = w.structured_evidence;
      if (
        meta?.official === true &&
        meta.adapterVersion === "nba-official-lineup-v1"
      )
        availableConditions.push({
          id: `${w.id}:lineup`,
          label: "Watch the official player lineup",
          condition: {
            kind: "official_lineup",
            subjectId: meta.subjectId,
            eventIds: [eventId],
            statement: "This player starts in the official lineup.",
            revisitWhen: "The player is not in the official starting lineup.",
            predicate: {
              type: "lineup_status",
              expected: "starter",
              revisitOn: "not_starter",
            },
            sourcePolicy: "official_required",
            validFrom: new Date(pick.now).toISOString(),
            validUntil: new Date(w.expires_at).toISOString(),
          },
        } as unknown as (typeof availableConditions)[number]);
    }
    const automatic = await availableOfficialLineupTemplates(
      c,
      pick,
      new Date(pick.now),
    );
    for (const t of automatic)
      availableConditions.push({
        id: t.id,
        label: t.label,
        condition: t.condition,
      } as unknown as (typeof availableConditions)[number]);
    const row = (
      await c.query(
        "SELECT r.payload,(SELECT count(*)::int FROM pick_watch_bindings b JOIN source_watches w ON w.id=b.watch_id AND w.user_id=b.user_id JOIN action_memory_preferences m ON m.user_id=b.user_id AND m.memory_consent WHERE b.reason_id=r.id AND b.user_id=$1 AND b.state='active' AND w.state='active' AND w.expires_at>clock_timestamp()) AS bindings FROM pick_reason_versions r JOIN picks p ON p.id=r.pick_id AND p.current_version=r.pick_version WHERE r.user_id=$1 AND r.pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [userId, pickId],
      )
    ).rows[0];
    return {
      basePickVersion: pick.current_version,
      availableConditions,
      reason: row?.payload ?? null,
      monitoring: {
        enabled: (row?.bindings ?? 0) > 0,
        bindingCount: row?.bindings ?? 0,
        unsupportedConditions:
          row?.payload?.conditions
            ?.filter((v: { kind: string }) => v.kind === "manual_review")
            .map(() => "Manual condition: review it yourself.") ?? [],
      },
    };
  });
}
