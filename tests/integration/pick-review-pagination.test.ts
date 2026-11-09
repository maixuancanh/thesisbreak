import { runOnePickImpactJob } from "../../packages/integrations/src/pick-impact-worker";
import { recordReviewedReportSnapshot } from "../../packages/integrations/src/reviewed-report-watch";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPick, type Snapshot } from "../../packages/db/src/picks";
import {
  confirmPickReason,
  readPickReason,
} from "../../packages/db/src/pick-reasons";
import {
  createSourceWatch,
  recordSourceWatchSnapshot,
} from "../../packages/db/src/source-watches";
import {
  listPickReviews,
  recordPickReviewAction,
} from "../../packages/db/src/pick-impact";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "review pagination and current version invariants",
  () => {
    const pool = new Pool({ connectionString: url });
    const owner = randomUUID(),
      eventId = `pagination-${owner}`,
      nativeId = eventId,
      picks: string[] = [],
      reviews: string[] = [];
    let watch: string;
    const snapshot: Snapshot = {
      platform: "kalshi",
      nativeId,
      eventId,
      question: "Synthetic pagination fixture",
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
      raw: { fixture: true, mode: "synthetic" },
    };
    beforeAll(async () => {
      if (!url || url === process.env.DATABASE_URL)
        throw Error("Separate test database required");
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
      await pool.query(
        "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,true)",
        [owner],
      );
      watch = (
        await createSourceWatch(pool, owner, {
          eventId,
          url: "https://publisher.test/report",
          originId: "fixture",
          contentClass: "json",
          selector: "/status",
          dependencyId: "report",
          hypothesisVersion: 1,
          eventEndAt: new Date(Date.now() + 86400000).toISOString(),
        })
      ).id;
      const source = (value: string) => ({
        eventId,
        url: "https://publisher.test/report",
        originId: "fixture",
        contentClass: "json",
        value,
        publishedAt: null,
      });
      await recordSourceWatchSnapshot(pool, owner, watch, source("A"));
      const change = await recordSourceWatchSnapshot(
        pool,
        owner,
        watch,
        source("B"),
      );
      for (let i = 0; i < 25; i++) {
        const pick = (await createPick(
          pool,
          owner,
          {
            platform: "kalshi",
            nativeId,
            outcome: "Yes",
            reason: "fixture",
            requestId: `create-${i}`,
          },
          async () => snapshot,
        )) as { pickId: string };
        picks.push(pick.pickId);
        const saved = (await confirmPickReason(pool, owner, pick.pickId, {
          requestId: `reason-${i}`,
          basePickVersion: 1,
          reason: "Original reason",
          conditions: [
            {
              kind: "source_correction",
              subjectId: eventId,
              eventIds: [eventId],
              statement: "Report remains current",
              revisitWhen: "Report corrected",
              predicate: {
                type: "source_revision",
                referenceId: "report",
                revisitOn: "corrected",
              },
              sourcePolicy: "reviewed_primary",
              validFrom: new Date(Date.now() - 3600000).toISOString(),
              validUntil: new Date(Date.now() + 86400000).toISOString(),
            },
          ],
          confirmed: true,
          enableMonitoring: true,
        })) as { reason: { id: string; revision: number } };
        const id = randomUUID();
        reviews.push(id);
        const payload = {
          id,
          changeId: change.changeId,
          pickId: pick.pickId,
          pickVersion: 1,
          reasonId: saved.reason.id,
          reasonRevision: saved.reason.revision,
          state: "needs_review",
          evidenceState: "contradicted",
          conditionMet: true,
          beforeRefs: [],
          afterRefs: [],
          explanation: "Synthetic controlled change",
          rulesVersion: "pagination-test",
          modelVersion: null,
        };
        await pool.query(
          "INSERT INTO pick_impact_assessments(id,user_id,change_id,reason_id,reason_revision,pick_id,pick_version,rules_version,state,payload,checked_at) VALUES($1,$2,$3,$4,$5,$6,1,'pagination-test','needs_review',$7,$8)",
          [
            id,
            owner,
            change.changeId,
            saved.reason.id,
            saved.reason.revision,
            pick.pickId,
            JSON.stringify(payload),
            `2026-11-02 12:00:00.${String(i + 1).padStart(6, "0")}+00`,
          ],
        );
      }
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("paginates more than twenty rows without losing microsecond ordering or global coverage", async () => {
      const first = await listPickReviews(pool, owner);
      expect(first.items).toHaveLength(20);
      expect(first.coverage).toEqual({
        trackedPicks: 25,
        totalPicks: 25,
        unconfiguredPicks: 0,
      });
      expect(first.items.every((r) => r.affectedPickCount === 25)).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const second = await listPickReviews(pool, owner, {
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items].map((r) => r.id);
      expect(ids).toEqual([...reviews].reverse());
      expect(new Set(ids).size).toBe(25);
      expect(second.coverage).toEqual(first.coverage);
    });
    it("refuses an old assessment even if its caller supplies the new current pick version", async () => {
      const pickId = picks[0]!,
        assessmentId = reviews[0]!;
      await pool.query(
        "INSERT INTO pick_versions(pick_id,user_id,version,parent_version,snapshot_id,outcome,reason,assumptions) SELECT pick_id,user_id,2,1,snapshot_id,outcome,reason,assumptions FROM pick_versions WHERE pick_id=$1 AND version=1",
        [pickId],
      );
      await pool.query("UPDATE picks SET current_version=2 WHERE id=$1", [
        pickId,
      ]);
      await expect(
        recordPickReviewAction(pool, owner, assessmentId, {
          requestId: "stale-current-version",
          assessmentId,
          basePickVersion: 2,
          reasonRevision: 1,
          action: "stop_watching",
          confirmed: true,
        }),
      ).rejects.toThrow("STALE_REVIEW");
      expect(
        (await listPickReviews(pool, owner)).items.some(
          (r) => r.id === assessmentId,
        ),
      ).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM pick_review_actions WHERE user_id=$1",
            [owner],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("never claims source coverage after consent revocation or watch expiry", async () => {
      await pool.query(
        "UPDATE action_memory_preferences SET memory_consent=false WHERE user_id=$1",
        [owner],
      );
      expect((await listPickReviews(pool, owner)).coverage.trackedPicks).toBe(
        0,
      );
      expect(
        (await readPickReason(pool, owner, picks[1]!)).monitoring.enabled,
      ).toBe(false);
      await pool.query(
        "UPDATE action_memory_preferences SET memory_consent=true WHERE user_id=$1",
        [owner],
      );
      await pool.query(
        "UPDATE source_watches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [watch],
      );
      expect((await listPickReviews(pool, owner)).coverage.trackedPicks).toBe(
        0,
      );
      expect(
        (await readPickReason(pool, owner, picks[1]!)).monitoring.enabled,
      ).toBe(false);
    });
    it("skips one hundred stale bindings and evaluates every condition of the current reason", async () => {
      const watchRow = await createSourceWatch(pool, owner, {
        eventId,
        url: "https://publisher.test/batch",
        originId: "fixture-batch",
        contentClass: "json",
        selector: "/status",
        dependencyId: "batch-report",
        hypothesisVersion: 1,
        eventEndAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const watchId = watchRow.id as string,
        target = {
          reportId: "batch-report-id",
          claimId: "batch-claim",
          eventId,
          subjectId: eventId,
        };
      const report = (status: "original" | "withdrawn") => ({
        ...target,
        status,
        content: "Controlled report fixture",
        citations: [],
        publishedAt: null,
      });
      await recordReviewedReportSnapshot(
        pool,
        owner,
        watchId,
        report("original"),
        target,
      );
      const snapshotId = (
        await pool.query(
          "SELECT snapshot_id FROM pick_versions WHERE pick_id=$1 AND version=1",
          [picks[0]],
        )
      ).rows[0].snapshot_id;
      for (let i = 0; i <= 100; i++) {
        const current = i === 100,
          pickId = randomUUID(),
          reasonId = `${current ? "z-current" : "a-stale"}-${owner}-${String(i).padStart(3, "0")}`;
        await pool.query(
          "INSERT INTO picks(id,user_id,platform,native_id,current_version) VALUES($1,$2,'kalshi',$3,1)",
          [pickId, owner, nativeId],
        );
        await pool.query(
          "INSERT INTO pick_versions(pick_id,user_id,version,snapshot_id,outcome,reason,assumptions) VALUES($1,$2,1,$3,'Yes','Synthetic batch fixture','[]')",
          [pickId, owner, snapshotId],
        );
        const conditions = ["corrected", "withdrawn"].map((revisitOn) => ({
          kind: "source_correction",
          subjectId: eventId,
          eventIds: [eventId],
          statement: "Controlled report status",
          revisitWhen: `Report ${revisitOn}`,
          predicate: {
            type: "source_revision",
            referenceId: "batch-report",
            revisitOn,
          },
          sourcePolicy: "reviewed_primary",
          validFrom: new Date(Date.now() - 3600000).toISOString(),
          validUntil: new Date(Date.now() + 86400000).toISOString(),
        }));
        const reason = {
          id: reasonId,
          ownerId: owner,
          pickId,
          pickVersion: 1,
          revision: 1,
          userText: "Synthetic batch reason",
          conditions,
          confirmedAt: new Date().toISOString(),
          evidenceRefs: [],
          mode: "synthetic",
        };
        await pool.query(
          "INSERT INTO pick_reason_versions(id,user_id,pick_id,pick_version,revision,payload,mode) VALUES($1,$2,$3,1,1,$4,'synthetic')",
          [reasonId, owner, pickId, JSON.stringify(reason)],
        );
        for (const conditionIndex of [0, 1])
          await pool.query(
            "INSERT INTO pick_watch_bindings(id,user_id,reason_id,watch_id,condition_index) VALUES($1,$2,$3,$4,$5)",
            [randomUUID(), owner, reasonId, watchId, conditionIndex],
          );
        if (!current) {
          await pool.query(
            "INSERT INTO pick_versions(pick_id,user_id,version,parent_version,snapshot_id,outcome,reason,assumptions) VALUES($1,$2,2,1,$3,'No','New version','[]')",
            [pickId, owner, snapshotId],
          );
          await pool.query("UPDATE picks SET current_version=2 WHERE id=$1", [
            pickId,
          ]);
        }
      }
      await recordReviewedReportSnapshot(
        pool,
        owner,
        watchId,
        report("withdrawn"),
        target,
      );
      const result = await runOnePickImpactJob(pool);
      expect(result.assessed).toBe(1);
      expect(result.completed).toBe(1);
      const assessments = (
        await pool.query(
          "SELECT payload FROM pick_impact_assessments WHERE user_id=$1 AND rules_version='pick-impact-v1'",
          [owner],
        )
      ).rows;
      expect(assessments).toHaveLength(1);
      expect(assessments[0].payload.state).toBe("needs_review");
      expect(assessments[0].payload.conditionMet).toBe(true);
      expect((await runOnePickImpactJob(pool)).assessed).toBe(0);
    });
  },
);
