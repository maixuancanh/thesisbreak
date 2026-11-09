import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPick,
  proposePick,
  confirmPick,
  type Snapshot,
} from "../../packages/db/src/picks";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import {
  createApprovedLesson,
  updateReviewedLesson,
} from "../../packages/db/src/lessons";
import {
  readResearchBriefing,
  readHabitReview,
} from "../../packages/db/src/research-memory";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("research memory (isolated PostgreSQL)", () => {
  const pool = new Pool({ connectionString: url });
  const user = randomUUID(),
    other = randomUUID(),
    empty = randomUUID();
  const markets = Array.from(
    { length: 3 },
    () => `MEMORY-${randomUUID().replaceAll("-", "").toUpperCase()}`,
  );
  const first = markets[0]!,
    second = markets[1]!,
    unmatched = markets[2]!;
  let pickId: string,
    lastRun: string,
    activeLesson: string,
    pausedLesson: string;
  const source = {
    id: "official-report",
    url: "https://www.nba.com/news/fixture",
    retrievedAt: new Date().toISOString(),
  };
  async function pick(owner: string, nativeId: string) {
    const snapshot: Snapshot = {
      platform: "kalshi",
      nativeId,
      eventId: null,
      question: "Fictional memory fixture?",
      outcomes: [
        { name: "Yes", price: 0.5 },
        { name: "No", price: 0.5 },
      ],
      rulesReference: "https://kalshi.com",
      rulesHash: "fixture",
      closeTime: null,
      fetchedAt: new Date().toISOString(),
      priceAsOf: null,
      nativeUnit: "probability",
      raw: { fixture: true },
    };
    return (await createPick(
      pool,
      owner,
      {
        platform: "kalshi",
        nativeId,
        outcome: "Yes",
        reason: "Original reason",
        requestId: randomUUID(),
      },
      async () => snapshot,
    )) as { pickId: string; version: number };
  }
  async function run(
    owner: string,
    nativeId: string,
    baseVersion = 1,
    message = "Review my reason",
  ) {
    const claimed = await claimRun(pool, owner, {
      platform: "kalshi",
      nativeId,
      provider: "public",
      message,
      requestId: randomUUID(),
    });
    await finishRun(
      pool,
      owner,
      claimed.id,
      {
        reply: {
          message: `Reply to ${message}`,
          reasonReview: {
            baseVersion,
            summary: "Recorded interpretation",
            claims: [
              {
                claim: "The starter will play",
                status: "unclear",
                explanation: "Participation has not been confirmed.",
                evidenceRefs: [source.id],
              },
            ],
          },
        },
        sources: [
          source,
          { ...source, id: "unreferenced", url: "https://kalshi.com" },
        ],
      },
      "completed",
    );
    return claimed.id;
  }
  async function lesson(owner: string, domain: string, sourceRunId?: string) {
    return createApprovedLesson(pool, owner, {
      requestId: randomUUID(),
      rule: "Check the official participation report before relying on availability.",
      scope: { domain, competition: "NBA" },
      confirmed: true,
      memoryConsent: true,
      ...(sourceRunId ? { sourceRunId } : {}),
    });
  }
  beforeAll(async () => {
    for (const id of [user, other, empty])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
    pickId = (await pick(user, first)).pickId;
    const proposal = (await proposePick(pool, user, pickId, {
      baseVersion: 1,
      changes: { outcome: "No", reason: "Updated reason" },
      reason: "Reviewed correction",
      requestId: randomUUID(),
    })) as { proposalId: string };
    await confirmPick(pool, user, pickId, {
      proposalId: proposal.proposalId,
      confirmed: true,
      requestId: randomUUID(),
    });
    await pick(user, second);
    await pick(other, first);
    await run(user, first, 1, "Earlier review");
    lastRun = await run(user, first, 2, "Latest completed review");
    await run(user, second);
    // Repeating a market, reviewing a nonexistent version, and reviewing without an owned pick add no distinct case.
    await run(user, second);
    await run(user, unmatched);
    await run(user, first, 999, "Invalid version review");
    // Make the intended last completed row deterministic; unfinished requests must not replace it.
    await pool.query(
      "UPDATE agent_runs SET finished_at=now()+interval '1 minute' WHERE id=$1",
      [lastRun],
    );
    await claimRun(pool, user, {
      platform: "kalshi",
      nativeId: first,
      provider: "public",
      message: "Unfinished newer request",
      requestId: randomUUID(),
    });
    await run(other, first);
    const active = await lesson(user, "Sports", lastRun);
    activeLesson = active.lessonId;
    await updateReviewedLesson(pool, user, activeLesson, {
      requestId: randomUUID(),
      baseVersion: 1,
      action: "edit",
      rule: "Check confirmed participation and the publication time of the official report.",
      scope: { domain: "Sports", competition: "NBA" },
      confirmed: true,
      memoryConsent: true,
    });
    const paused = await lesson(user, "Sports");
    pausedLesson = paused.lessonId;
    await updateReviewedLesson(pool, user, pausedLesson, {
      requestId: randomUUID(),
      baseVersion: 1,
      action: "paused",
      confirmed: true,
    });
    await lesson(user, "Economics");
    await lesson(other, "Sports");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [
      [user, other, empty],
    ]);
    await pool.query("DELETE FROM market_snapshots WHERE native_id=ANY($1)", [
      markets,
    ]);
    await pool.query("DELETE FROM markets WHERE native_id=ANY($1)", [markets]);
    await pool.end();
  });
  it("returns the owned current pick and latest completed conversation, with current applicable lessons and preserved old history", async () => {
    const briefing = await readResearchBriefing(
      pool,
      user,
      { platform: "kalshi", id: first, provider: "public" },
      { domain: "Sports", competition: "NBA" },
    );
    expect(briefing.currentPick).toMatchObject({
      id: pickId,
      version: 2,
      outcome: "No",
      reason: "Updated reason",
    });
    expect(briefing.lastConversation).toMatchObject({
      runId: lastRun,
      message: "Latest completed review",
      sources: expect.arrayContaining([source]),
    });
    expect(briefing.applicableLessons).toHaveLength(1);
    expect(briefing.applicableLessons[0]).toMatchObject({
      currentVersion: 2,
      lesson: { id: activeLesson, version: 2, status: "active" },
      origin: { runId: lastRun, nativeId: first },
    });
    expect(
      briefing.lessonHistory
        .filter((row) => row.lesson.id === activeLesson)
        .map((row) => row.lesson.version),
    ).toEqual([2, 1]);
    expect(
      briefing.lessonHistory
        .filter((row) => row.lesson.id === pausedLesson)
        .map((row) => row.lesson.status),
    ).toEqual(["paused", "active"]);
    expect(
      briefing.lessonHistory.every((row) => row.lesson.userId === user),
    ).toBe(true);
    const unscoped = await readResearchBriefing(pool, user, {
      platform: "kalshi",
      id: first,
      provider: "public",
    });
    expect(unscoped.applicableLessons).toEqual([]);
    const foreign = await readResearchBriefing(
      pool,
      empty,
      { platform: "kalshi", id: first, provider: "public" },
      { domain: "Sports", competition: "NBA" },
    );
    expect(foreign.currentPick).toBeNull();
    expect(foreign.lastConversation).toBeNull();
    expect(foreign.lessonHistory).toEqual([]);
  });
  it("counts two distinct owned cases, retains only claim citations, and excludes absent pick versions and other accounts", async () => {
    const review = await readHabitReview(pool, user);
    expect(review.status).toBe("repeated_claims");
    expect(review.reviewedCases).toBe(2);
    expect(review.patterns).toHaveLength(1);
    const cases = review.patterns[0]!.cases;
    expect(new Set(cases.map((item) => item.nativeId))).toEqual(
      new Set([first, second]),
    );
    expect(cases.find((item) => item.nativeId === first)).toMatchObject({
      runId: lastRun,
      pickId,
      pickVersion: 2,
    });
    expect(
      cases.every(
        (item) =>
          item.sources.length === 1 && item.sources[0]?.id === source.id,
      ),
    ).toBe(true);
    expect(await readHabitReview(pool, other)).toMatchObject({
      status: "insufficient_history",
      reviewedCases: 1,
      patterns: [],
    });
    expect(await readHabitReview(pool, empty)).toMatchObject({
      status: "insufficient_history",
      reviewedCases: 0,
      patterns: [],
    });
  });
});
