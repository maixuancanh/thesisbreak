import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import {
  saveIndependentChecks,
  readIndependentChecks,
} from "../../packages/db/src/independent-evidence";
it.skipIf(!process.env.TEST_DATABASE_URL)(
  "persists immutable source revisions and isolates exact market bindings",
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      nativeId = `NEWS-${randomUUID()}`;
    const m = { platform: "kalshi" as const, nativeId };
    const check = {
      source: "nba-official",
      state: "available" as const,
      background: false,
      checkedAt: new Date().toISOString(),
      items: [
        {
          id: "one",
          url: "https://official.nba.com/report",
          title: "Report",
          text: "Player out",
          publishedAt: null,
          retrievedAt: new Date().toISOString(),
          eventDate: "2026-10-26",
          teams: ["Los Angeles Lakers", "Utah Jazz"],
          player: "James, LeBron",
          status: "Out",
        },
      ],
    };
    try {
      await saveIndependentChecks(pool, m, [check]);
      await saveIndependentChecks(pool, m, [check]);
      expect((await readIndependentChecks(pool, m))[0]?.items).toEqual(
        check.items,
      );
      expect(
        await readIndependentChecks(pool, {
          ...m,
          nativeId: nativeId + "OTHER",
        }),
      ).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM independent_evidence WHERE native_id=$1",
            [nativeId],
          )
        ).rows[0].n,
      ).toBe(1);
      await saveIndependentChecks(pool, m, [
        {
          ...check,
          state: "unavailable",
          items: [],
          checkedAt: new Date().toISOString(),
        },
      ]);
      expect((await readIndependentChecks(pool, m))[0]?.state).toBe(
        "unavailable",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM independent_evidence WHERE native_id=$1",
            [nativeId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await pool.query(
        "DELETE FROM independent_source_checks WHERE native_id=$1",
        [nativeId],
      );
      await pool.query("DELETE FROM independent_evidence WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.end();
    }
  },
);
