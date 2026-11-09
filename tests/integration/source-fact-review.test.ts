import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  registerSourceForecast,
  recordSourceFactReview,
  listSourceScores,
} from "../../packages/db/src/source-credibility";
import { validateSourceScore } from "../../packages/domain/src/source-credibility";
import { applyResearchMemoryPolicy } from "../../packages/agent/src/memory-policy";
describe.skipIf(!process.env.TEST_DATABASE_URL)("scoped source reviews", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
    owner = randomUUID(),
    other = randomUUID();
  let profileId: string;
  beforeAll(async () => {
    for (const id of [owner, other])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
    const r = await registerSourceForecast(pool, owner, {
      platform: "kalshi",
      nativeId: "KXNBAGAME-TEST-" + randomUUID(),
      sourceId: "fixture",
      sourceName: "Test source",
      kind: "user_reported_forecaster",
      cohort: "sports:NBA",
      outcome: "Yes",
      probability: 0.6,
      baselineProbability: null,
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      reference: "https://example.com/forecast",
      rulesHash: "fixture",
      memoryConsent: true,
    });
    profileId = r.sourceProfileId;
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
    await pool.end();
  });
  it("preserves exact forecast scope and human provenance through score rebuild and validation", async () => {
    const input = {
      profileId,
      requestId: randomUUID(),
      claim: "The official lineup includes Player A",
      sourceReference: "https://example.com/report",
      evidenceReference: "https://www.nba.com/report",
      verdict: "supported",
      scope: { league: "NBA", market: "winner", horizon: "pregame" },
      confirmed: true,
    };
    await expect(recordSourceFactReview(pool, other, input)).rejects.toThrow(
      "NOT_FOUND",
    );
    const saved = await recordSourceFactReview(pool, owner, input);
    expect(await recordSourceFactReview(pool, owner, input)).toEqual(saved);
    await expect(
      recordSourceFactReview(pool, owner, { ...input, verdict: "refuted" }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    const s = validateSourceScore(
      (await listSourceScores(pool, owner))[0]!.payload,
    );
    expect(s.factReviews?.[0]).toMatchObject({
      reviewer: "account_owner",
      verification: "user_review_not_independently_verified",
    });
    expect(s.forecasts[0]?.scope).toEqual(input.scope);
    const policy = applyResearchMemoryPolicy({
      userId: owner,
      now: new Date(),
      requestedScope: input.scope,
      sourceMemories: [s],
      forecastMemories: [],
    });
    expect(policy.sourceAssessments[0]).toMatchObject({
      factSamples: 1,
      factRate: 1,
      forecastSamples: 0,
      factVerification: "account_owner_review_not_independently_verified",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM outbox WHERE user_id=$1 AND kind='source.score.created'",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
    await recordSourceFactReview(pool, owner, {
      ...input,
      requestId: randomUUID(),
      verdict: "refuted",
    });
    const corrected = validateSourceScore(
      (await listSourceScores(pool, owner))[0]!.payload,
    );
    expect(corrected.factReviews).toHaveLength(1);
    expect(corrected.factReviews?.[0]?.verdict).toBe("refuted");
  });
});
