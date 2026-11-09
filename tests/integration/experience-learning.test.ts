import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import {
  recordLearningExperience,
  createLessonCandidate,
  reviewLessonCandidate,
  listLearningCandidates,
} from "../../packages/db/src/experience-learning";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("owner-scoped experience learning database", () => {
  const pool = new Pool({ connectionString: url }),
    owner = randomUUID(),
    other = randomUUID();
  let runId = "",
    sessionId = "";
  const message = "Require official lineup before changing this event.";
  const atomId = randomUUID();
  const hash = createHash("sha256").update(message).digest("hex");
  beforeAll(async () => {
    for (const id of [owner, other])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
    const run = await claimRun(pool, owner, {
      platform: "polymarket",
      nativeId: "123",
      provider: "public",
      message,
      requestId: randomUUID(),
    });
    runId = run.id;
    sessionId = run.conversationId;
    await pool.query(
      "UPDATE conversations SET memory_consent=true WHERE user_id=$1 AND id=$2",
      [owner, sessionId],
    );
    await finishRun(pool, owner, run.id, { reply: {} }, "completed");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
    await pool.end();
  });
  it("rejects foreign runs and fabricated originals; ingests once, edits immutably and approves once through outbox", async () => {
    const experience = {
      requestId: randomUUID(),
      runId,
      sessionId,
      eventId: "game-A",
      modelVersion: "test",
      promptVersion: "v1",
      prerequisites: [],
      outcome: null,
      atoms: [
        {
          id: atomId,
          origin: "user_statement",
          reference: `${runId}:message`,
          version: 1,
          hash,
          text: message,
          eventId: "game-A",
          publishedAt: null,
          occurredAt: null,
          retrievedAt: new Date().toISOString(),
          sourceOrigin: `user:${owner}`,
        },
      ],
    };
    await expect(
      recordLearningExperience(pool, other, experience),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      recordLearningExperience(pool, owner, {
        ...experience,
        atoms: [{ ...experience.atoms[0], text: "invented" }],
      }),
    ).rejects.toThrow("ORIGINAL_MESSAGE_MISMATCH");
    const e = await recordLearningExperience(pool, owner, experience);
    expect(await recordLearningExperience(pool, owner, experience)).toEqual(e);
    await expect(
      recordLearningExperience(pool, owner, {
        ...experience,
        eventId: "changed",
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    const input = {
      requestId: randomUUID(),
      kind: "research_procedure",
      scope: { domain: "Sports", competition: "NBA", eventId: "game-A" },
      statement: "Require official lineup",
      experienceIds: [e.id],
      evidence: [
        { atomId, version: 1, hash, stance: "support", quote: message },
      ],
      modelVersion: "test",
      promptVersion: "v1",
      condition: {
        type: "require_official_lineup",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    };
    await expect(createLessonCandidate(pool, other, input)).rejects.toThrow(
      "INVALID_EVIDENCE_REFERENCE",
    );
    const c = await createLessonCandidate(pool, owner, input);
    expect(await createLessonCandidate(pool, owner, input)).toEqual(c);
    expect(await listLearningCandidates(pool, other)).toEqual([]);
    const edited = await reviewLessonCandidate(pool, owner, c.id, {
      requestId: randomUUID(),
      baseVersion: 1,
      action: "edit",
      confirmed: true,
      statement: "Only change after official lineup",
      scope: input.scope,
      condition: input.condition,
    });
    expect(edited.version).toBe(2);
    const approve = {
      requestId: randomUUID(),
      baseVersion: 2,
      action: "approve",
      confirmed: true,
      memoryConsent: true,
    };
    await expect(
      reviewLessonCandidate(pool, other, c.id, approve),
    ).rejects.toThrow("NOT_FOUND");
    const result = await reviewLessonCandidate(pool, owner, c.id, approve);
    expect(await reviewLessonCandidate(pool, owner, c.id, approve)).toEqual(
      result,
    );
    const outbox = (
      await pool.query(
        "SELECT payload FROM outbox WHERE user_id=$1 AND kind='lesson.version.created'",
        [owner],
      )
    ).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.memoryConsent).toBe(true);
    const versions = await listLearningCandidates(pool, owner);
    expect(versions.map((v) => v.status).sort()).toEqual([
      "approved",
      "superseded",
    ]);
    expect(versions.every((v) => v.payload.evidence[0].hash === hash)).toBe(
      true,
    );
    const conflict = await createLessonCandidate(pool, owner, {
      ...input,
      requestId: randomUUID(),
      condition: {
        type: "require_fresh_quote",
        maxAgeSeconds: 60,
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
    const conflictRow = (await listLearningCandidates(pool, owner)).find(
      (row) => row.id === conflict.id,
    );
    expect(conflictRow.consolidation).toMatchObject({
      classification: "conflict",
      relatedId: c.id,
      relatedVersion: 2,
      requiresReview: true,
    });
    await expect(
      reviewLessonCandidate(pool, owner, conflict.id, {
        ...approve,
        requestId: randomUUID(),
        baseVersion: 1,
      }),
    ).rejects.toThrow("CONSOLIDATION_REVIEW_REQUIRED");
    const conflictApproval = await reviewLessonCandidate(
      pool,
      owner,
      conflict.id,
      {
        ...approve,
        requestId: randomUUID(),
        baseVersion: 1,
        acknowledgeConflict: true,
      },
    );
    expect(conflictApproval.status).toBe("approved");
    const opposite =
      "The official report says the lineup is not yet published.";
    const distinctRun = await claimRun(pool, owner, {
      platform: "polymarket",
      nativeId: "123",
      provider: "public",
      message: opposite,
      sessionId,
      requestId: randomUUID(),
    });
    await finishRun(pool, owner, distinctRun.id, { reply: {} }, "completed");
    const distinctAtomId = randomUUID(),
      distinctHash = createHash("sha256").update(opposite).digest("hex");
    const distinctExperience = await recordLearningExperience(pool, owner, {
      ...experience,
      requestId: randomUUID(),
      runId: distinctRun.id,
      atoms: [
        {
          ...experience.atoms[0],
          id: distinctAtomId,
          reference: `${distinctRun.id}:message`,
          hash: distinctHash,
          text: opposite,
        },
      ],
    });
    const semantic = {
      ...input,
      requestId: randomUUID(),
      statement: "Lineup is not yet published; preserve the earlier check.",
      experienceIds: [distinctExperience.id],
      evidence: [
        {
          atomId: distinctAtomId,
          version: 1,
          hash: distinctHash,
          stance: "support",
          quote: opposite,
        },
      ],
      consolidationProposal: {
        classification: "conflict",
        relatedId: c.id,
        relatedVersion: 2,
        relatedEvidence: input.evidence,
      },
    };
    await expect(
      createLessonCandidate(pool, owner, {
        ...semantic,
        consolidationProposal: {
          ...semantic.consolidationProposal,
          relatedVersion: 999,
        },
      }),
    ).rejects.toThrow("INVALID_CONSOLIDATION_REFERENCE");
    const semanticSaved = await createLessonCandidate(pool, owner, semantic);
    const semanticRow = (await listLearningCandidates(pool, owner)).find(
      (row) => row.id === semanticSaved.id,
    );
    expect(semanticRow.status).toBe("pending_review");
    expect(semanticRow.consolidation).toMatchObject({
      classification: "conflict",
      relatedId: c.id,
      relatedVersion: 2,
      requiresReview: true,
      modelVersion: input.modelVersion,
    });
    expect(semanticRow.payload.evidence[0].atomId).toBe(distinctAtomId);
    expect(semanticRow.payload.evidence[0].atomId).not.toBe(atomId);
    await expect(
      reviewLessonCandidate(pool, owner, semanticSaved.id, {
        ...approve,
        requestId: randomUUID(),
        baseVersion: 1,
      }),
    ).rejects.toThrow("CONSOLIDATION_REVIEW_REQUIRED");
    const expired = await createLessonCandidate(pool, owner, {
      ...input,
      requestId: randomUUID(),
      condition: { ...input.condition, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    await expect(
      reviewLessonCandidate(pool, owner, expired.id, {
        ...approve,
        requestId: randomUUID(),
        baseVersion: 1,
        acknowledgeConflict: true,
      }),
    ).rejects.toThrow("CONDITION_EXPIRED");
    const auditRun = async () => {
      const run = await claimRun(pool, owner, {
        platform: "polymarket",
        nativeId: "123",
        provider: "public",
        message: "Audit this application",
        requestId: randomUUID(),
      });
      await finishRun(
        pool,
        owner,
        run.id,
        { reply: {}, appliedConditions: [{ id: result.lessonId, version: 1 }] },
        "completed",
      );
      return (
        await pool.query(
          "SELECT * FROM lesson_applications WHERE user_id=$1 AND run_id=$2",
          [owner, run.id],
        )
      ).rows[0];
    };
    const pendingAudit = await auditRun();
    expect(pendingAudit.candidate_id).toBe(c.id);
    expect(pendingAudit.candidate_version).toBe(2);
    expect(pendingAudit.payload.authorityAtCommit).toBe(false);
    await pool.query(
      "UPDATE outbox SET state='done' WHERE user_id=$1 AND payload->>'lessonId'=$2",
      [owner, result.lessonId],
    );
    expect((await auditRun()).payload.authorityAtCommit).toBe(true);
    const next = await createLessonCandidate(pool, owner, {
      ...input,
      requestId: randomUUID(),
    });
    await pool.query(
      "UPDATE memory_atoms SET withdrawn_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
      [owner, atomId],
    );
    await expect(
      reviewLessonCandidate(pool, owner, next.id, {
        ...approve,
        requestId: randomUUID(),
        baseVersion: 1,
        acknowledgeConflict: true,
      }),
    ).rejects.toThrow("EVIDENCE_WITHDRAWN");
    expect((await auditRun()).payload.authorityAtCommit).toBe(false);
  });
});
