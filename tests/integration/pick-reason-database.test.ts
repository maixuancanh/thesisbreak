import { runOneProsePickImpactJob } from "../../packages/integrations/src/pick-impact-prose-worker";
import { rejectPickProposal } from "../../packages/db/src/decision-outcomes";
import { recordReviewedReportSnapshot } from "../../packages/integrations/src/reviewed-report-watch";
import { pollSourceWatch } from "../../packages/integrations/src/source-watch";
import { fetchOfficialNbaGame } from "../../packages/integrations/src/news/nba-game";
import { recordOfficialNbaLineupSnapshot } from "../../packages/integrations/src/official-lineup-watch";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createPick,
  proposePick,
  confirmPick,
  type Snapshot,
} from "../../packages/db/src/picks";
import {
  confirmPickReason,
  readPickReason,
} from "../../packages/db/src/pick-reasons";
import {
  createSourceWatch,
  recordSourceWatchSnapshot,
} from "../../packages/db/src/source-watches";
import { runOnePickImpactJob } from "../../packages/integrations/src/pick-impact-worker";
import {
  listPickReviews,
  recordPickReviewAction,
} from "../../packages/db/src/pick-impact";
import { listSharedReasons } from "../../packages/db/src/source-lineage";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "confirmed reason monitoring transaction lifecycle",
  () => {
    const pool = new Pool({ connectionString: url });
    const owner = randomUUID(),
      other = randomUUID(),
      eventId = `event-${owner}`,
      nativeId = `reason-${owner}`;
    let pick1: string,
      pick2: string,
      paused: string,
      foreign: string,
      watch: string;
    const condition = () => ({
      kind: "source_correction",
      subjectId: eventId,
      eventIds: [eventId],
      statement: "Report supports availability",
      revisitWhen: "Report corrected",
      predicate: {
        type: "source_revision",
        referenceId: "report",
        revisitOn: "corrected",
      },
      sourcePolicy: "reviewed_primary",
      validFrom: new Date(Date.now() - 3600000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    });
    const snapshot: Snapshot = {
      platform: "kalshi",
      nativeId,
      eventId,
      question: "Acceptance fixture only?",
      outcomes: [
        { name: "Yes", price: 0.5 },
        { name: "No", price: 0.5 },
      ],
      rulesReference: "https://publisher.test/rules",
      rulesHash: "fixture",
      closeTime: null,
      fetchedAt: new Date().toISOString(),
      priceAsOf: null,
      nativeUnit: "probability",
      raw: { fixture: true },
    };
    const source = (value: string) => ({
      eventId,
      originId: "official",
      url: "https://publisher.test/report",
      contentClass: "json",
      value,
      publishedAt: null,
    });
    const save = (pickId: string, requestId: string) =>
      confirmPickReason(pool, owner, pickId, {
        requestId,
        basePickVersion: 1,
        reason: "My original reason",
        conditions: [condition()],
        confirmed: true,
        enableMonitoring: true,
      });
    beforeAll(async () => {
      for (const user of [owner, other]) {
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [user],
        );
        await pool.query(
          "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true)",
          [user],
        );
      }
      for (const [index, user] of [owner, owner, owner, other].entries()) {
        const pick = (await createPick(
          pool,
          user,
          {
            platform: "kalshi",
            nativeId,
            outcome: "Yes",
            reason: "fixture",
            requestId: `create-${index}`,
          },
          async () => snapshot,
        )) as { pickId: string };
        if (index === 0) pick1 = pick.pickId;
        if (index === 1) pick2 = pick.pickId;
        if (index === 2) paused = pick.pickId;
        if (index === 3) foreign = pick.pickId;
      }
      watch = (
        await createSourceWatch(pool, owner, {
          eventId,
          url: "https://publisher.test/report",
          originId: "official",
          contentClass: "json",
          selector: "/status",
          dependencyId: "report",
          hypothesisVersion: 1,
          eventEndAt: new Date(Date.now() + 86400000).toISOString(),
        })
      ).id;
      await recordSourceWatchSnapshot(pool, owner, watch, source("A"));
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("keeps legacy picks unconfigured, saves idempotently, rejects stale/cross-owner and binds exact sources", async () => {
      expect((await readPickReason(pool, owner, pick1)).reason).toBeNull();
      const payload = {
        requestId: "reason-one",
        basePickVersion: 1,
        reason: "My original reason",
        conditions: [condition()],
        confirmed: true,
        enableMonitoring: true,
      };
      const results = await Promise.all([
        confirmPickReason(pool, owner, pick1, payload),
        confirmPickReason(pool, owner, pick1, payload),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(
        (results[0] as { monitoring: { bindingCount: number } }).monitoring
          .bindingCount,
      ).toBe(1);
      await expect(
        confirmPickReason(pool, owner, pick1, {
          ...payload,
          reason: "changed",
        }),
      ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
      await expect(
        confirmPickReason(pool, owner, pick1, {
          ...payload,
          requestId: "stale",
          basePickVersion: 2,
        }),
      ).rejects.toThrow("STALE_PICK_VERSION");
      await expect(readPickReason(pool, other, pick1)).rejects.toThrow(
        "NOT_FOUND",
      );
      await save(pick2, "reason-two");
      await save(paused, "reason-paused");
      await pool.query(
        "UPDATE pick_watch_bindings b SET state='paused' FROM pick_reason_versions r WHERE r.id=b.reason_id AND r.pick_id=$1",
        [paused],
      );
      await confirmPickReason(pool, other, foreign, {
        requestId: "foreign-reason",
        basePickVersion: 1,
        reason: "Foreign reason",
        conditions: [condition()],
        confirmed: true,
        enableMonitoring: true,
      });
      expect(
        (await listSharedReasons(pool, owner)).items[0]?.pickIds.sort(),
      ).toEqual([pick1, pick2].sort());
    });
    it("fans out exact active owner bindings; Keep closes only one revision; next change reopens independently", async () => {
      const change = await recordSourceWatchSnapshot(
        pool,
        owner,
        watch,
        source("B"),
      );
      expect(change.status).toBe("changed");
      const work = await runOnePickImpactJob(pool);
      expect(work.assessed).toBe(2);
      expect((await runOnePickImpactJob(pool)).assessed).toBe(0);
      const reviews = await listPickReviews(pool, owner);
      expect(reviews.items.map((r) => r.pickId).sort()).toEqual(
        [pick1, pick2].sort(),
      );
      expect(
        reviews.items.every((r) => r.state === "waiting_confirmation"),
      ).toBe(true);
      expect((await listPickReviews(pool, other)).items).toHaveLength(0);
      const review = reviews.items.find((r) => r.pickId === pick1)!;
      const action = {
        requestId: "keep-first",
        assessmentId: review.id,
        basePickVersion: 1,
        reasonRevision: review.reasonRevision,
        action: "keep",
        confirmed: true,
      };
      await expect(
        recordPickReviewAction(pool, other, review.id, action),
      ).rejects.toThrow("NOT_FOUND");
      await expect(
        recordPickReviewAction(pool, owner, review.id, {
          ...action,
          basePickVersion: 2,
        }),
      ).rejects.toThrow("STALE_REVIEW");
      expect(
        await recordPickReviewAction(pool, owner, review.id, action),
      ).toEqual(await recordPickReviewAction(pool, owner, review.id, action));
      expect(
        (await listPickReviews(pool, owner)).items.find(
          (r) => r.id === review.id,
        )?.closed,
      ).toBe(true);
      await recordSourceWatchSnapshot(pool, owner, watch, source("A"));
      expect((await runOnePickImpactJob(pool)).assessed).toBe(2);
      expect(
        (await listPickReviews(pool, owner)).items.filter((r) => !r.closed),
      ).toHaveLength(3);
    });
    it("Stop watching isolates one pick and revoked consent prevents queued assessment", async () => {
      const review = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick1 && !r.closed,
      )!;
      await recordPickReviewAction(pool, owner, review.id, {
        requestId: "stop",
        assessmentId: review.id,
        basePickVersion: 1,
        reasonRevision: review.reasonRevision,
        action: "stop_watching",
        confirmed: true,
      });
      expect(
        (await readPickReason(pool, owner, pick1)).monitoring.enabled,
      ).toBe(false);
      expect(
        (await readPickReason(pool, owner, pick2)).monitoring.enabled,
      ).toBe(true);
      await recordSourceWatchSnapshot(pool, owner, watch, source("C"));
      await pool.query(
        "UPDATE action_memory_preferences SET memory_consent=false WHERE user_id=$1",
        [owner],
      );
      expect((await runOnePickImpactJob(pool)).assessed).toBe(0);
      await expect(
        pool.query(
          "UPDATE pick_reason_versions SET payload='{}' WHERE user_id=$1",
          [owner],
        ),
      ).rejects.toThrow("append-only");
    });
    it("turns exact official adapter lineup changes into needs_review without treating text as official", async () => {
      await pool.query(
        "UPDATE action_memory_preferences SET memory_consent=true WHERE user_id=$1",
        [owner],
      );
      const target = {
        gameId: "0042400407",
        eventDate: "2025-06-22",
        homeTeam: "OKC",
        awayTeam: "IND",
      };
      const players = (offset: number, changed: boolean) =>
        Array.from({ length: 6 }, (_, i) => ({
          personId: offset + i,
          firstName: "Test",
          familyName: `Player${i}`,
          starter: changed ? i > 0 : i < 5,
        }));
      const officialResult = async (changed: boolean) => {
        const game = {
          gameId: target.gameId,
          gameCode: "20250622/INDOKC",
          gameStatus: 1,
          gameStatusText: "Scheduled",
          gameTimeUTC: "2025-06-23T00:00:00Z",
          homeTeam: {
            teamId: 10,
            teamName: "Thunder",
            teamCity: "Oklahoma City",
            teamTricode: "OKC",
            score: 0,
            players: players(100, changed),
          },
          awayTeam: {
            teamId: 20,
            teamName: "Pacers",
            teamCity: "Indiana",
            teamTricode: "IND",
            score: 0,
            players: players(200, false),
          },
        };
        return fetchOfficialNbaGame(target, {
          transport: async () => new Response(JSON.stringify({ game })),
        });
      };

      const officialUrl = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${target.gameId}.json`;
      const w = await createSourceWatch(pool, owner, {
        eventId,
        url: officialUrl,
        originId: "nba_official",
        contentClass: "json",
        selector: "/game/homeTeam/players",
        dependencyId: "official-lineup",
        hypothesisVersion: 1,
        eventEndAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const registration = { target, personId: 100, eventId };
      await recordOfficialNbaLineupSnapshot(
        pool,
        owner,
        w.id,
        await officialResult(false),
        registration,
      );
      const pick = (await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "fixture",
          requestId: "create-official-lineup",
        },
        async () => snapshot,
      )) as { pickId: string };
      const saved = (await confirmPickReason(pool, owner, pick.pickId, {
        requestId: "reason-official-lineup",
        basePickVersion: 1,
        reason: "This player starts.",
        conditions: [
          {
            ...condition(),
            kind: "official_lineup",
            subjectId: "nba-player:100",
            predicate: {
              type: "lineup_status",
              expected: "starter",
              revisitOn: "not_starter",
            },
            sourcePolicy: "official_required",
          },
        ],
        confirmed: true,
        enableMonitoring: true,
      })) as { monitoring: { enabled: boolean } };
      expect(saved.monitoring.enabled).toBe(true);
      await recordOfficialNbaLineupSnapshot(
        pool,
        owner,
        w.id,
        await officialResult(true),
        registration,
      );
      expect((await runOnePickImpactJob(pool)).assessed).toBe(1);
      const review = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick.pickId,
      );
      expect(review?.state).toBe("needs_review");
      expect(review?.conditionMet).toBe(true);
      expect(review?.evidenceState).toBe("contradicted");
      await expect(
        recordOfficialNbaLineupSnapshot(
          pool,
          owner,
          w.id,
          await officialResult(true),
          { ...registration, personId: 99999 },
        ),
      ).rejects.toThrow("OFFICIAL_LINEUP_UNCONFIRMED");
    });
    it("persists Update intent and closes it only after the existing proposal is confirmed", async () => {
      const review = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick2 && !r.closed,
      )!;
      const action = {
        requestId: "request-update",
        assessmentId: review.id,
        basePickVersion: 1,
        reasonRevision: review.reasonRevision,
        action: "update",
        confirmed: true,
      };
      const prepared = (await recordPickReviewAction(
        pool,
        owner,
        review.id,
        action,
      )) as { status: string };
      expect(prepared.status).toBe("proposal_required");
      expect(
        (await listPickReviews(pool, owner)).items.find(
          (r) => r.id === review.id,
        )?.closed,
      ).toBe(false);
      let proposal = (await proposePick(
        pool,
        owner,
        pick2,
        {
          requestId: "proposal-update",
          baseVersion: 1,
          changes: { reason: "My revised reason" },
          reason: "Reconsidered the changed report",
        },
        snapshot,
      )) as { proposalId: string };
      await rejectPickProposal(pool, owner, pick2, {
        requestId: "reject-first-review-update",
        proposalId: proposal.proposalId,
        confirmed: true,
      });
      await recordPickReviewAction(pool, owner, review.id, {
        ...action,
        requestId: "request-update-retry",
      });
      proposal = (await proposePick(
        pool,
        owner,
        pick2,
        {
          requestId: "proposal-update-retry",
          baseVersion: 1,
          changes: { reason: "Revised reason after rejected draft" },
          reason: "Reconsidered changed report",
        },
        snapshot,
      )) as { proposalId: string };
      const linked = (
        await pool.query(
          "SELECT proposal_id FROM pick_review_proposals WHERE user_id=$1 AND assessment_id=$2",
          [owner, review.id],
        )
      ).rows[0];
      expect(linked.proposal_id).toBe(proposal.proposalId);
      await confirmPick(
        pool,
        owner,
        pick2,
        {
          requestId: "confirm-update",
          proposalId: proposal.proposalId,
          confirmed: true,
        },
        snapshot,
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM pick_review_actions WHERE user_id=$1 AND assessment_id=$2 AND action='update'",
            [owner, review.id],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        recordPickReviewAction(pool, owner, review.id, {
          ...action,
          requestId: "malicious-stale",
          basePickVersion: 2,
          action: "stop_watching",
        }),
      ).rejects.toThrow("STALE_REVIEW");
    });
    it("imports verified report revisions and citation lineage; reports outage separately and recovers", async () => {
      const reportUrl = "https://publisher.test/structured";
      const citedUrl = "https://publisher.test/cited";
      const w = await createSourceWatch(pool, owner, {
        eventId,
        url: reportUrl,
        originId: "publisher",
        contentClass: "json",
        selector: "/status",
        dependencyId: "structured",
        hypothesisVersion: 1,
        eventEndAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const citedWatch = await createSourceWatch(pool, owner, {
        eventId,
        url: citedUrl,
        originId: "cited",
        contentClass: "json",
        selector: "/status",
        dependencyId: "cited",
        hypothesisVersion: 1,
        eventEndAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const target = {
        reportId: "report-123",
        claimId: "availability",
        eventId,
        subjectId: "player-subject",
      };
      const report = (status: "original" | "corrected") => ({
        ...target,
        status,
        content: "Original report with exact source citation.",
        citations: [citedUrl],
        publishedAt: null,
      });
      const citedTarget = { ...target, reportId: "cited-456" };
      await recordReviewedReportSnapshot(
        pool,
        owner,
        citedWatch.id,
        {
          ...citedTarget,
          status: "original",
          content: "Primary report",
          citations: [],
          publishedAt: null,
        },
        citedTarget,
      );
      await recordReviewedReportSnapshot(
        pool,
        owner,
        w.id,
        report("original"),
        target,
      );
      const pick = (await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "fixture",
          requestId: "create-report-revision",
        },
        async () => snapshot,
      )) as { pickId: string };
      const state = await readPickReason(pool, owner, pick.pickId);
      expect(state.availableConditions.some((t) => t.id === w.id)).toBe(true);
      await confirmPickReason(pool, owner, pick.pickId, {
        requestId: "reason-report-revision",
        basePickVersion: 1,
        reason: "Based on this report",
        conditions: [
          {
            ...condition(),
            subjectId: target.subjectId,
            predicate: {
              type: "source_revision",
              referenceId: "structured",
              revisitOn: "corrected",
            },
          },
        ],
        confirmed: true,
        enableMonitoring: true,
      });
      const citedPick = (await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "fixture",
          requestId: "create-cited-report",
        },
        async () => snapshot,
      )) as { pickId: string };
      await confirmPickReason(pool, owner, citedPick.pickId, {
        requestId: "reason-cited-report",
        basePickVersion: 1,
        reason: "Same underlying claim",
        conditions: [
          {
            ...condition(),
            subjectId: target.subjectId,
            predicate: {
              type: "source_revision",
              referenceId: "cited",
              revisitOn: "corrected",
            },
          },
        ],
        confirmed: true,
        enableMonitoring: true,
      });
      const shared = (await listSharedReasons(pool, owner)).items.find((g) =>
        g.pickIds.includes(pick.pickId),
      );
      expect(shared?.originStatus).toBe("verified");
      expect(shared?.pickIds.sort()).toEqual(
        [pick.pickId, citedPick.pickId].sort(),
      );
      await recordReviewedReportSnapshot(
        pool,
        owner,
        w.id,
        report("corrected"),
        target,
      );
      expect((await runOnePickImpactJob(pool)).assessed).toBe(1);
      expect(
        (await listPickReviews(pool, owner)).items.find(
          (r) => r.pickId === pick.pickId,
        )?.state,
      ).toBe("needs_review");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM source_lineage_edges WHERE user_id=$1 AND payload->>'verification'='verified'",
            [owner],
          )
        ).rows[0].n,
      ).toBeGreaterThan(0);
      await pool.query(
        "UPDATE source_watches SET next_check_at=clock_timestamp() WHERE id=$1",
        [w.id],
      );
      await pollSourceWatch(pool, owner, w.id, {
        enabled: true,
        publisherHosts: ["publisher.test"],
        fetchText: async () => {
          throw Error("timeout");
        },
      });
      expect((await runOnePickImpactJob(pool)).assessed).toBe(1);
      const failed = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick.pickId,
      );
      expect(failed?.state).toBe("check_unavailable");
      expect(failed?.conditionMet).toBeNull();
      expect(failed?.evidenceState).toBe("unclear");
      await recordReviewedReportSnapshot(
        pool,
        owner,
        w.id,
        report("corrected"),
        target,
      );
      expect((await runOnePickImpactJob(pool)).assessed).toBe(1);
    });
    it("lets a fresh owner confirm a verified event/player template and poll without technical configuration", async () => {
      const fresh = randomUUID();
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        fresh,
      ]);
      await pool.query(
        "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true)",
        [fresh],
      );
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 1);
      start.setUTCHours(17, 0, 0, 0);
      const eventDate = start.toISOString().slice(0, 10);
      const month = [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ][start.getUTCMonth()];
      const event = `KXNBAGAME-${String(start.getUTCFullYear()).slice(-2)}${month}${String(start.getUTCDate()).padStart(2, "0")}INDOKC`;
      const native = `${event}-OKC`;
      const target = {
        gameId: "0042400407",
        eventDate,
        homeTeam: "OKC",
        awayTeam: "IND",
      };
      const transport =
        (changed: boolean): typeof fetch =>
        async () =>
          new Response(
            JSON.stringify({
              game: {
                gameId: target.gameId,
                gameCode: `${eventDate.replaceAll("-", "")}/INDOKC`,
                gameStatus: 1,
                gameStatusText: "Scheduled",
                gameTimeUTC: start.toISOString(),
                homeTeam: {
                  teamId: 10,
                  teamName: "Thunder",
                  teamCity: "Oklahoma City",
                  teamTricode: "OKC",
                  score: 0,
                  players: Array.from({ length: 6 }, (_, i) => ({
                    personId: 100 + i,
                    firstName: "Home",
                    familyName: `Player${i}`,
                    starter: changed ? i > 0 : i < 5,
                  })),
                },
                awayTeam: {
                  teamId: 20,
                  teamName: "Pacers",
                  teamCity: "Indiana",
                  teamTricode: "IND",
                  score: 0,
                  players: Array.from({ length: 6 }, (_, i) => ({
                    personId: 200 + i,
                    firstName: "Away",
                    familyName: `Player${i}`,
                    starter: i < 5,
                  })),
                },
              },
            }),
          );
      const official = await fetchOfficialNbaGame(target, {
        transport: transport(false),
      });
      expect(official.state).toBe("available");
      const publicId = randomUUID();
      await pool.query(
        "INSERT INTO nba_public_snapshots(id,source_url,retrieved_at,content_hash,payload) VALUES($1,$2,clock_timestamp(),$3,$4)",
        [
          publicId,
          official.provenance!.sourceUrl,
          randomUUID(),
          JSON.stringify(official),
        ],
      );
      try {
        const pick = (await createPick(
          pool,
          fresh,
          {
            platform: "kalshi",
            nativeId: native,
            outcome: "Yes",
            reason: "fixture",
            requestId: "fresh-pick",
          },
          async () => ({ ...snapshot, nativeId: native, eventId: event }),
        )) as { pickId: string };
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM source_watches WHERE user_id=$1",
              [fresh],
            )
          ).rows[0].n,
        ).toBe(0);
        const initial = await readPickReason(pool, fresh, pick.pickId);
        const template = initial.availableConditions.find(
          (t) => t.condition.subjectId === "nba-player:100",
        );
        expect(template).toBeDefined();
        const saved = (await confirmPickReason(pool, fresh, pick.pickId, {
          requestId: "fresh-reason",
          basePickVersion: 1,
          reason: "Home Player0 starts.",
          conditions: [template!.condition],
          confirmed: true,
          enableMonitoring: true,
        })) as { monitoring: { enabled: boolean } };
        expect(saved.monitoring.enabled).toBe(true);
        const w = (
          await pool.query("SELECT id FROM source_watches WHERE user_id=$1", [
            fresh,
          ])
        ).rows[0];
        await pollSourceWatch(pool, fresh, w.id, {
          enabled: true,
          publisherHosts: [],
          officialLineupTransport: transport(true),
        });
        expect((await runOnePickImpactJob(pool)).assessed).toBe(1);
        expect((await listPickReviews(pool, fresh)).items[0]?.state).toBe(
          "needs_review",
        );
      } finally {
        await pool.query("DELETE FROM users WHERE id=$1", [fresh]);
        await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
          native,
        ]);
        await pool.query("DELETE FROM markets WHERE native_id=$1", [native]);
        await pool.query("DELETE FROM nba_public_snapshots WHERE id=$1", [
          publicId,
        ]);
      }
    });
    it("runs one budgeted prose assessment remotely, rejects fabricated quotes and records model timeout unavailable", async () => {
      // Other learning suites share the service counter in this test database.
      // Match their test allowance while retaining the real owner/model bounds.
      const env = {
        PICK_IMPACT_PROSE_ENABLED: "true",
        LEARNING_DAILY_ATTEMPTS: "10000",
      };
      for (let i = 0; i < 10; i++) {
        const drained = await runOneProsePickImpactJob(pool, env, async () => {
          throw Error("Should not call model for disabled old binding");
        });
        if (!drained.checked) break;
      }
      const pick = (await createPick(
        pool,
        owner,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "fixture",
          requestId: "create-prose-pick",
        },
        async () => snapshot,
      )) as { pickId: string };
      await save(pick.pickId, "prose-reason");
      const change = async (text: string) => {
        await recordSourceWatchSnapshot(pool, owner, watch, source(text));
        expect((await runOnePickImpactJob(pool)).assessed).toBe(1);
      };
      await change("Correction: the player is unavailable.");
      expect(
        (
          await runOneProsePickImpactJob(pool, env, async (request) => {
            const prompt = JSON.parse(request.prompt);
            const after = Object.keys(prompt.snapshots).find((key) =>
              key.includes(":after:"),
            )!;
            return {
              subjectId: eventId,
              eventId,
              evidenceRefs: [after],
              quotedSpans: [
                { ref: after, quote: "Correction: the player is unavailable." },
              ],
              evidenceState: "contradicted",
              conditionMet: true,
              explanation:
                "The publisher corrected the availability statement.",
            };
          })
        ).completed,
      ).toBe(1);
      const proseJobs = (
        await pool.query(
          "SELECT j.state,j.payload FROM learning_jobs j JOIN pick_impact_assessments a ON a.id=j.payload->>'assessmentId' AND a.user_id=j.user_id WHERE j.user_id=$1 AND j.kind='pick_impact_prose' AND a.pick_id=$2",
          [owner, pick.pickId],
        )
      ).rows;
      expect(proseJobs).toHaveLength(1);
      expect(proseJobs[0].state).toBe("completed");
      expect(proseJobs[0].payload.budgetAttempts).toHaveLength(1);
      expect(proseJobs[0].payload.budgetAttempts[0]).toMatchObject({
        unit: "bounded_model_attempt",
        reservedAttempts: 1,
        maxInputBytes: 20000,
        maxOutputTokens: 1500,
        ownerDailyLimit: 10,
        serviceDailyLimit: 10000,
      });
      expect(
        (await listPickReviews(pool, owner)).items.find(
          (r) => r.pickId === pick.pickId,
        )?.state,
      ).toBe("needs_review");
      await change("New report without a matching quotation.");
      await runOneProsePickImpactJob(pool, env, async (request) => {
        const prompt = JSON.parse(request.prompt);
        const after = Object.keys(prompt.snapshots).find((key) =>
          key.includes(":after:"),
        )!;
        return {
          subjectId: eventId,
          eventId,
          evidenceRefs: [after],
          quotedSpans: [{ ref: after, quote: "Fabricated unavailable claim" }],
          evidenceState: "contradicted",
          conditionMet: true,
          explanation: "Fabricated claim rejected.",
        };
      });
      const invalid = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick.pickId,
      );
      expect(invalid?.state).toBe("waiting_confirmation");
      expect(invalid?.conditionMet).toBeNull();
      await change("Another source revision.");
      await runOneProsePickImpactJob(pool, env, async () => {
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      });
      const unavailable = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick.pickId,
      );
      expect(unavailable?.state).toBe("check_unavailable");
      expect(unavailable?.conditionMet).toBeNull();
      await change("Correction: a later source update.");
      const pending = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick.pickId,
      )!;
      await runOneProsePickImpactJob(pool, env, async (request) => {
        await recordPickReviewAction(pool, owner, pending.id, {
          requestId: "keep-while-model-running",
          assessmentId: pending.id,
          basePickVersion: 1,
          reasonRevision: pending.reasonRevision,
          action: "keep",
          confirmed: true,
        });
        const prompt = JSON.parse(request.prompt);
        const after = Object.keys(prompt.snapshots).find((key) =>
          key.includes(":after:"),
        )!;
        return {
          subjectId: eventId,
          eventId,
          evidenceRefs: [after],
          quotedSpans: [
            { ref: after, quote: "Correction: a later source update." },
          ],
          evidenceState: "contradicted",
          conditionMet: true,
          explanation: "This result must be discarded after Keep.",
        };
      });
      const kept = (await listPickReviews(pool, owner)).items.find(
        (r) => r.pickId === pick.pickId,
      )!;
      expect(kept.id).toBe(pending.id);
      expect(kept.closed).toBe(true);
    });
  },
);
