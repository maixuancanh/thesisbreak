import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  deriveResearchArtifact,
  enqueueResearchArtifactMemory,
  claimResearchArtifactMemory,
  finishResearchArtifactMemory,
  loadResearchArtifactMemory,
  assertResearchArtifactAuthority,
  prepareNextResearchArtifactMemory,
} from "../../packages/db/src/research-artifact-memory";
import {
  researchArtifactHash,
  researchMemoryBytes,
} from "../../packages/domain/src/research-memory-version";
import {
  runResearchArtifactMemoryOnce,
  recallResearchArtifactForPlanning,
  maintainResearchArtifactMemory,
} from "../../packages/integrations/src/research-artifact-memory";
import {
  MemwalAdapter,
  type MemoryClient,
} from "../../packages/integrations/src/memwal";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "research artifact Walrus lifecycle (isolated DB, offline transport)",
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const owner = randomUUID(),
      reviewer = randomUUID(),
      foreign = randomUUID();
    beforeAll(async () => {
      await pool.query(
        "INSERT INTO users(id,provider_subject) VALUES($1,$1),($2,$2),($3,$3)",
        [owner, reviewer, foreign],
      );
      await pool.query(
        "INSERT INTO procedure_reviewer_authorizations(user_id) VALUES($1)",
        [reviewer],
      );
    });
    afterAll(async () => {
      await pool.query(
        "DELETE FROM research_artifact_memory_publications WHERE owner_id=$1",
        [owner],
      );
      await pool.query(
        "DELETE FROM research_artifact_memory_grants WHERE owner_id=$1",
        [owner],
      );
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [
        [owner, reviewer, foreign],
      ]);
      await pool.end();
    });
    async function source() {
      const watch = randomUUID(),
        id = randomUUID(),
        grant = randomUUID();
      await pool.query(
        "INSERT INTO source_watches(id,user_id,event_id,url,origin_id,content_class,selector,dependency_id,hypothesis_version,expires_at,poll_seconds) VALUES($1,$2,'event','https://example.com','official','json','value','dependency',1,clock_timestamp()+interval '1 hour',300)",
        [watch, owner],
      );
      await pool.query(
        "INSERT INTO source_change_events(id,watch_id,user_id,before_hash,after_hash,sequence,before_value,after_value) VALUES($1,$2,$3,$4,$5,1,'out','available')",
        [id, watch, owner, "a".repeat(64), "b".repeat(64)],
      );
      const artifact = await deriveResearchArtifact(
        pool,
        owner,
        "source_change",
        id,
      );
      await pool.query(
        "INSERT INTO research_artifact_memory_grants(id,owner_id,kind,artifact_id,snapshot_hash,namespace_kind,consent_evidence_ref,consented_at) VALUES($1,$2,'source_change',$3,$4,'evaluation','synthetic-test-only',clock_timestamp())",
        [grant, owner, id, researchArtifactHash(artifact.snapshot)],
      );
      return {
        watch,
        grant,
        args: {
          ownerId: owner,
          reviewerId: reviewer,
          grantId: grant,
          kind: "source_change" as const,
          artifactId: id,
        },
      };
    }
    function transport() {
      let text = "",
        namespace = "",
        mode = "valid",
        writes = 0,
        clients = 0,
        destroyed = 0;
      const keys: string[] = [];
      let afterRead: (() => Promise<void>) | undefined;
      const createAdapter = () => {
        clients++;
        const client: MemoryClient = {
          rememberAndWait: async (t, n, o) => {
            writes++;
            text = t;
            namespace = n;
            keys.push(o.idempotencyKey);
            return { id: "job", blob_id: "blob", owner: "test", namespace: n };
          },
          recall: async (q) => {
            await afterRead?.();
            const hits =
              q.namespace === namespace && mode !== "missing"
                ? [
                    {
                      text:
                        mode === "reformatted"
                          ? JSON.stringify(JSON.parse(text), null, 2)
                          : text,
                      blob_id: mode === "wrong-blob" ? "other" : "blob",
                      distance: 0,
                    },
                  ]
                : [];
            return { results: hits, total: hits.length };
          },
          restore: async (n) => ({
            namespace: n,
            owner: "test",
            restored: 0,
            skipped: 0,
            failed: 0,
            total: 0,
            truncated: false,
          }),
          destroy: () => {
            destroyed++;
          },
        };
        return new MemwalAdapter(client, owner);
      };
      return {
        createAdapter,
        setMode: (v: string) => {
          mode = v;
        },
        afterRead: (fn: () => Promise<void>) => {
          afterRead = fn;
        },
        stats: () => ({ writes, clients, destroyed, keys, text }),
      };
    }
    it("prepares without remote writes; retry reuses immutable version, bytes and idempotency; fresh client gates planning", async () => {
      const f = await source(),
        t = transport();
      await expect(
        enqueueResearchArtifactMemory(pool, { ...f.args, ownerId: foreign }),
      ).rejects.toThrow();
      const id = await enqueueResearchArtifactMemory(pool, f.args);
      expect(await enqueueResearchArtifactMemory(pool, f.args)).toBe(id);
      expect(t.stats().writes).toBe(0);
      await expect(
        pool.query(
          "UPDATE research_artifact_memory_publications SET record='{}' WHERE id=$1",
          [id],
        ),
      ).rejects.toThrow("IMMUTABLE");
      const input = {
        id,
        ownerId: owner,
        reviewerId: reviewer,
        enabled: true,
        createAdapter: t.createAdapter,
      };
      expect(
        await runResearchArtifactMemoryOnce(pool, { ...input, enabled: false }),
      ).toMatchObject({ checked: 0 });
      t.setMode("missing");
      expect(await runResearchArtifactMemoryOnce(pool, input)).toMatchObject({
        checked: 1,
        verified: 0,
      });
      await pool.query(
        "UPDATE research_artifact_memory_publications SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
      t.setMode("valid");
      expect(await runResearchArtifactMemoryOnce(pool, input)).toMatchObject({
        checked: 1,
        verified: 1,
      });
      expect(await runResearchArtifactMemoryOnce(pool, input)).toMatchObject({
        checked: 0,
      });
      const c = await loadResearchArtifactMemory(pool, input);
      expect(t.stats().text).toBe(researchMemoryBytes(owner, c.record));
      expect(new Set(t.stats().keys).size).toBe(1);
      for (const mode of ["missing", "wrong-blob", "reformatted"]) {
        t.setMode(mode);
        expect(
          (await recallResearchArtifactForPlanning(pool, input)).status,
        ).toBe("blocked");
      }
      t.setMode("valid");
      const planning = await recallResearchArtifactForPlanning(pool, input);
      expect(planning.status).toBe("verified");
      expect(planning.checks).toEqual(["recheck_changed_source_dependency"]);
      expect(planning.evidence[0]).toMatchObject({
        version: 1,
        blobId: "blob",
        causalBenefit: "not_measured",
      });
      expect(t.stats().clients).toBe(t.stats().destroyed);
      expect(
        (
          await pool.query(
            "SELECT fresh_verified_at FROM research_artifact_memory_publications WHERE id=$1",
            [id],
          )
        ).rows[0].fresh_verified_at,
      ).toBeTruthy();
      t.afterRead(async () => {
        await pool.query(
          "UPDATE research_artifact_memory_grants SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.grant],
        );
      });
      expect(
        (await recallResearchArtifactForPlanning(pool, input)).status,
      ).toBe("blocked");
      await expect(assertResearchArtifactAuthority(pool, c)).rejects.toThrow(
        "AUTHORITY",
      );
    });
    it("revocation while pending prevents SDK construction and old/stale leases cannot save receipts", async () => {
      const f = await source(),
        t = transport(),
        id = await enqueueResearchArtifactMemory(pool, f.args),
        input = { id, ownerId: owner, reviewerId: reviewer };
      const c = (await claimResearchArtifactMemory(pool, input))!;
      expect(await claimResearchArtifactMemory(pool, input)).toBeNull();
      expect(
        await finishResearchArtifactMemory(
          pool,
          { ...c, token: "stale" },
          { status: "verified", hash: c.recordHash, blobId: "blob" },
        ),
      ).toBe(false);
      await pool.query(
        "UPDATE research_artifact_memory_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.grant],
      );
      expect(
        await finishResearchArtifactMemory(pool, c, {
          status: "verified",
          hash: c.recordHash,
          blobId: "blob",
        }),
      ).toBe(false);
      expect(
        await runResearchArtifactMemoryOnce(pool, {
          ...input,
          enabled: true,
          createAdapter: t.createAdapter,
        }),
      ).toMatchObject({ checked: 0 });
      expect(t.stats().clients).toBe(0);
    });
    it("rechecks consent after remote write and rejects stale source/watch pointers", async () => {
      const f = await source(),
        t = transport(),
        id = await enqueueResearchArtifactMemory(pool, f.args),
        input = { id, ownerId: owner, reviewerId: reviewer };
      t.afterRead(async () => {
        await pool.query(
          "UPDATE research_artifact_memory_grants SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.grant],
        );
      });
      expect(
        await runResearchArtifactMemoryOnce(pool, {
          ...input,
          enabled: true,
          createAdapter: t.createAdapter,
        }),
      ).toMatchObject({ verified: 0 });
      expect(
        (
          await pool.query(
            "SELECT receipt FROM research_artifact_memory_publications WHERE id=$1",
            [id],
          )
        ).rows[0].receipt,
      ).toBeNull();
      const f2 = await source(),
        id2 = await enqueueResearchArtifactMemory(pool, f2.args);
      await pool.query("UPDATE source_watches SET state='paused' WHERE id=$1", [
        f2.watch,
      ]);
      await expect(
        loadResearchArtifactMemory(pool, { ...input, id: id2 }),
      ).rejects.toThrow("NOT_AVAILABLE");
    });
    it("official result corrections link original forecast and previous revision without rewriting historical memory", async () => {
      const forecast = randomUUID(),
        result1 = randomUUID(),
        result2 = randomUUID(),
        event = randomUUID();
      await pool.query(
        "INSERT INTO nba_forecasts(id,user_id,namespace,event_id,horizon,method_version,scheduled_at,captured_at,payload,request_hash,memory_consent) VALUES($1,$2,'live',$3,'T24h','test',clock_timestamp()+interval '1 day',clock_timestamp(),$4,'request',true)",
        [
          forecast,
          owner,
          event,
          { rationale: "synthetic original evidence", probability: 0.7 },
        ],
      );
      for (const [id, revision, winner] of [
        [result1, 1, "home"],
        [result2, 2, "away"],
      ] as const)
        await pool.query(
          "INSERT INTO nba_forecast_results(id,user_id,namespace,event_id,revision,payload) VALUES($1,$2,'live',$3,$4,$5)",
          [
            id,
            owner,
            event,
            revision,
            {
              revision,
              verifiedOfficial: true,
              sourceUrl: "https://www.nba.com/game/test",
              winner,
            },
          ],
        );
      const a = await deriveResearchArtifact(
          pool,
          owner,
          "forecast_result",
          result1,
        ),
        b = await deriveResearchArtifact(
          pool,
          owner,
          "forecast_result",
          result2,
        );
      expect(a.logicalId).toBe(b.logicalId);
      expect(a.version).toBe(1);
      expect(b.version).toBe(2);
      expect(b.snapshot.previousResult).toMatchObject({
        id: result1,
        revision: 1,
      });
      expect(b.snapshot.originalForecasts).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: forecast })]),
      );
      expect(a.snapshot.payload).toMatchObject({ winner: "home" });
      await expect(
        pool.query("UPDATE nba_forecast_results SET payload='{}' WHERE id=$1", [
          result1,
        ]),
      ).rejects.toThrow("IMMUTABLE");
    });
    it("changed retained source snapshot invalidates exact consent and bounded maintenance prepares locally with zero clients", async () => {
      const f = await source(),
        t = transport();
      await pool.query(
        "UPDATE source_change_events SET after_value='corrected' WHERE id=$1",
        [f.args.artifactId],
      );
      await expect(enqueueResearchArtifactMemory(pool, f.args)).rejects.toThrow(
        "AUTHORITY_DENIED",
      );
      const next = await source();
      const local = await maintainResearchArtifactMemory(pool, {
        enabled: true,
        allowRemoteSync: false,
        createAdapter: t.createAdapter,
      });
      expect(local.prepared).toBe(1);
      expect(local.checked).toBe(0);
      expect(t.stats().clients).toBe(0);
      const queued = await pool.query(
        "SELECT count(*)::int AS n FROM research_artifact_memory_publications WHERE owner_id=$1 AND artifact_id=$2",
        [owner, next.args.artifactId],
      );
      expect(queued.rows[0].n).toBe(1);
      expect(await prepareNextResearchArtifactMemory(pool)).toMatchObject({
        prepared: 0,
      });
    });
    it("derives a meaningful drift snapshot only from complete integrity-checked online learning results", async () => {
      const id = randomUUID(),
        payload = { ownerId: owner, jobId: randomUUID() },
        result = {
          method: "river.predict_then_learn.ADWIN",
          automaticAuthority: false,
          samples: 20,
          streams: [
            {
              key: ["NBA", "winner", "T24h", "v1"],
              status: "drift_review",
              samples: 20,
              delta: 0.1,
              window: 10,
            },
          ],
        };
      await pool.query(
        "INSERT INTO research_jobs(id,user_id,namespace,kind,operation_key,payload,payload_hash,state,result,result_hash) VALUES($1,$2,'evaluation','online_learning',$1,$3,$4,'completed',$5,$6)",
        [
          id,
          owner,
          payload,
          researchArtifactHash(payload),
          result,
          researchArtifactHash(result),
        ],
      );
      expect(
        (await deriveResearchArtifact(pool, owner, "drift_summary", id))
          .snapshot.result,
      ).toEqual(result);
      await pool.query("UPDATE research_jobs SET result_hash=$2 WHERE id=$1", [
        id,
        "a".repeat(64),
      ]);
      await expect(
        deriveResearchArtifact(pool, owner, "drift_summary", id),
      ).rejects.toThrow("HASH_MISMATCH");
    });
  },
);
