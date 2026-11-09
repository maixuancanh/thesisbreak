import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import {
  recordLearningExperience,
  createLessonCandidate,
  reviewLessonCandidate,
} from "../../packages/db/src/experience-learning";
import { loadCurrentApprovedLessons } from "../../packages/db/src/approved-lessons";
import { materializeApprovedLessonIndex } from "../../packages/integrations/src/memory-index-worker";
import { createPostgresMemoryIndex } from "../../packages/db/src/memory-index";
import { APPROVED_LESSON_INDEX_NAMESPACE } from "../../packages/domain/src/approved-lesson-index";
const url = process.env.TEST_DATABASE_URL;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
describe.skipIf(!url || url === process.env.DATABASE_URL)(
  "approved lesson receipt materialization",
  () => {
    const pool = new Pool({ connectionString: url });
    const owner = randomUUID();
    let session = "";
    let hash = "";
    const eventId = "native-event-A";
    const rule = "Require official lineup before changing this event.";
    beforeAll(async () => {
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
      const run = await claimRun(pool, owner, {
        platform: "kalshi",
        nativeId: "native-market-A",
        provider: "public",
        message: rule,
        requestId: randomUUID(),
      });
      session = run.conversationId;
      await pool.query(
        "UPDATE conversations SET memory_consent=true WHERE id=$1 AND user_id=$2",
        [session, owner],
      );
      await finishRun(
        pool,
        owner,
        run.id,
        {
          marketRef: { platform: "kalshi", nativeId: "native-market-A" },
          learningEvidence: [
            {
              id: "market-source",
              eventId,
              text: JSON.stringify({ scheduledAt: "2026-11-05T01:00:00.000Z" }),
            },
          ],
        },
        "completed",
      );
      const atomId = randomUUID(),
        atomHash = createHash("sha256").update(rule).digest("hex");
      const experience = await recordLearningExperience(pool, owner, {
        requestId: randomUUID(),
        sessionId: session,
        runId: run.id,
        eventId,
        modelVersion: "fixture",
        promptVersion: "fixture",
        prerequisites: [],
        outcome: null,
        atoms: [
          {
            id: atomId,
            origin: "user_statement",
            reference: `${run.id}:message`,
            version: 1,
            hash: atomHash,
            text: rule,
            eventId,
            publishedAt: null,
            occurredAt: null,
            retrievedAt: new Date().toISOString(),
            sourceOrigin: `user:${owner}`,
          },
        ],
      });
      const candidate = await createLessonCandidate(pool, owner, {
        requestId: randomUUID(),
        kind: "research_procedure",
        scope: { domain: "Sports", eventId },
        statement: rule,
        experienceIds: [experience.id],
        evidence: [
          {
            atomId,
            version: 1,
            hash: atomHash,
            stance: "support",
            quote: rule,
          },
        ],
        modelVersion: "fixture",
        promptVersion: "fixture",
        condition: null,
      });
      await reviewLessonCandidate(pool, owner, candidate.id, {
        requestId: randomUUID(),
        baseVersion: 1,
        action: "approve",
        confirmed: true,
        memoryConsent: true,
      });
      const [lesson] = await loadCurrentApprovedLessons(pool, owner);
      expect(lesson).toBeDefined();
      const record = {
        logicalId: lesson!.id,
        type: "lesson",
        version: 1,
        recordedAt: new Date().toISOString(),
        payload: lesson,
      };
      hash = createHash("sha256")
        .update(canonical({ ...record, schema: 1, userId: owner }))
        .digest("hex");
      const receipt = {
        status: "verified",
        hash,
        blobId: "fixture-exact-blob",
      };
      const row = (
        await pool.query(
          "UPDATE outbox SET state='done',outcome=$2 WHERE user_id=$1 AND kind='lesson.version.created' RETURNING operation_key",
          [owner, { record, result: receipt }],
        )
      ).rows[0];
      await pool.query(
        "INSERT INTO memory_records(logical_id,user_id,schema_version,type,payload_hash,durable_reference,receipt,sync_status) VALUES($1,$2,1,'lesson',$3,$4,$5,'verified')",
        [row.operation_key, owner, atomHash, receipt.blobId, receipt],
      );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.end();
    });
    it("uses actual receipt and native schedule, rejects altered receipts, purges revoked sessions", async () => {
      const query = {
        ownerId: owner,
        namespace: APPROVED_LESSON_INDEX_NAMESPACE,
        event: { provider: "kalshi", nativeId: eventId, date: "2026-11-05" },
        cutoffAt: new Date(Date.now() + 60000).toISOString(),
        query: "lineup",
        entities: [],
        scope: { domain: "Sports" },
      };
      expect((await materializeApprovedLessonIndex(pool, owner)).indexed).toBe(
        1,
      );
      const search = createPostgresMemoryIndex(pool),
        found = await search(query);
      expect(found[0]?.pointer).toMatchObject({
        ownerId: owner,
        sha256: hash,
        blobId: "fixture-exact-blob",
        version: 1,
      });
      expect(
        await search({
          ...query,
          event: { ...query.event, date: "2026-11-06" },
        }),
      ).toEqual([]);
      expect(await search({ ...query, ownerId: randomUUID() })).toEqual([]);
      expect(
        await search({ ...query, cutoffAt: "2026-10-01T00:00:00.000Z" }),
      ).toEqual([]);
      // Old approval time is never substituted for absent native schedule metadata.
      const original = (
        await pool.query("SELECT result FROM agent_runs WHERE user_id=$1", [
          owner,
        ])
      ).rows[0].result;
      await pool.query(
        "UPDATE agent_runs SET result=jsonb_set(result,'{learningEvidence,0,text}',to_jsonb($2::text)) WHERE user_id=$1",
        [owner, JSON.stringify({})],
      );
      expect((await materializeApprovedLessonIndex(pool, owner)).indexed).toBe(
        0,
      );
      await pool.query("UPDATE agent_runs SET result=$2 WHERE user_id=$1", [
        owner,
        original,
      ]);
      // Repeated provenance for the same lesson/event remains one deterministic pointer.
      await pool.query(
        "UPDATE lesson_candidates SET payload=jsonb_set(payload,'{experienceIds}',(payload->'experienceIds')||(payload->'experienceIds')) WHERE user_id=$1",
        [owner],
      );
      expect((await materializeApprovedLessonIndex(pool, owner)).indexed).toBe(
        1,
      );
      await pool.query(
        "UPDATE memory_records SET receipt=jsonb_set(receipt,'{hash}',to_jsonb($2::text)) WHERE user_id=$1",
        [owner, "a".repeat(64)],
      );
      expect((await materializeApprovedLessonIndex(pool, owner)).indexed).toBe(
        0,
      );
      await pool.query(
        "UPDATE memory_records SET receipt=jsonb_set(receipt,'{hash}',to_jsonb($2::text)) WHERE user_id=$1",
        [owner, hash],
      );
      expect((await materializeApprovedLessonIndex(pool, owner)).indexed).toBe(
        1,
      );
      await pool.query(
        "UPDATE conversations SET memory_consent=false WHERE id=$1 AND user_id=$2",
        [session, owner],
      );
      expect((await materializeApprovedLessonIndex(pool, owner)).indexed).toBe(
        0,
      );
      expect(await search(query)).toEqual([]);
    });
  },
);
