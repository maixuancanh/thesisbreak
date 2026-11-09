import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertJourneyDatabase } from "../../packages/agent/src/application-journey";
import { createPick, type Snapshot } from "../../packages/db/src/picks";
import { confirmPickReason } from "../../packages/db/src/pick-reasons";
import { prepareDecisionRecap } from "../../packages/db/src/decision-recaps";
import type { ReasonVersion } from "../../packages/domain/src/pick-reason";

const url = process.env.JOURNEY_EVAL_DATABASE_URL;
describe.skipIf(!url)("server-derived acceptance reason mode", () => {
  const pool = new Pool({ connectionString: url });
  const owner = `reason-mode:${randomUUID()}`;
  const nativeId = owner;
  const snapshot: Snapshot = {
    platform: "kalshi",
    nativeId,
    eventId: nativeId,
    question: "Isolated reason classification fixture",
    outcomes: [{ name: "Yes", price: 0.5 }],
    rulesReference: "https://example.test/rules",
    rulesHash: "fixture",
    closeTime: null,
    fetchedAt: new Date().toISOString(),
    priceAsOf: null,
    nativeUnit: "probability",
    raw: { fixture: true },
  };
  beforeAll(async () => {
    assertJourneyDatabase(url!, process.env.DATABASE_URL);
    await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
      owner,
    ]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=$1", [owner]);
    await pool.query(
      "DELETE FROM market_snapshots WHERE platform=$1 AND native_id=$2",
      [snapshot.platform, nativeId],
    );
    await pool.query("DELETE FROM markets WHERE platform=$1 AND native_id=$2", [
      snapshot.platform,
      nativeId,
    ]);
    await pool.end();
  });
  const create = async (reason: string) =>
    (await createPick(
      pool,
      owner,
      {
        platform: snapshot.platform,
        nativeId,
        outcome: "Yes",
        reason,
        requestId: randomUUID(),
      },
      async () => snapshot,
    )) as { pickId: string };
  const save = async (pickId: string, reason: string) =>
    (await confirmPickReason(pool, owner, pickId, {
      requestId: randomUUID(),
      basePickVersion: 1,
      reason,
      conditions: [],
      confirmed: true,
      enableMonitoring: false,
    })) as { reason: ReasonVersion };

  it("inherits the original pick test label through reason edits and recap creation", async () => {
    const pick = await create(
      "  aCcEpTaNcE TeSt OnLy: explicitly labelled fixture",
    );
    const first = await save(
      pick.pickId,
      "Updated explanation without the prefix",
    );
    expect(first.reason.mode).toBe("acceptance_test");
    expect(
      (await save(pick.pickId, "A later edit still belongs to the test")).reason
        .mode,
    ).toBe("acceptance_test");
    const stored = (
      await pool.query(
        "SELECT mode,payload FROM pick_reason_versions WHERE user_id=$1 AND pick_id=$2 ORDER BY revision",
        [owner, pick.pickId],
      )
    ).rows;
    expect(
      stored.every(
        (r) =>
          r.mode === "acceptance_test" && r.payload.mode === "acceptance_test",
      ),
    ).toBe(true);
    expect((await prepareDecisionRecap(pool, owner, pick.pickId)).mode).toBe(
      "acceptance_test",
    );
  });
  it("retains an explicit submitted test classification after later reason edits", async () => {
    const pick = await create("Ordinary starting reason");
    expect(
      (
        await save(
          pick.pickId,
          " Acceptance test only: marked during reason confirmation",
        )
      ).reason.mode,
    ).toBe("acceptance_test");
    expect(
      (await save(pick.pickId, "Removed the label from this edit")).reason.mode,
    ).toBe("acceptance_test");
    expect((await prepareDecisionRecap(pool, owner, pick.pickId)).mode).toBe(
      "acceptance_test",
    );
  });
  it("keeps ordinary reasons live without classifying incidental text as the prefix", async () => {
    const pick = await create("Ordinary starting reason");
    expect(
      (
        await save(
          pick.pickId,
          "We discussed Acceptance test only: as quoted text",
        )
      ).reason.mode,
    ).toBe("live");
    expect((await prepareDecisionRecap(pool, owner, pick.pickId)).mode).toBe(
      "live",
    );
  });
});
