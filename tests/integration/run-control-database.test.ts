import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { cancelRun, readRun } from "../../packages/db/src/agent-run-control";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("run cancellation durable concurrency", () => {
  const pool = new Pool({ connectionString: url });
  const owner = randomUUID(),
    other = randomUUID();
  const nativeId = `RUN-${randomUUID().replaceAll("-", "").toUpperCase()}`;
  beforeAll(async () => {
    for (const id of [owner, other])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
    await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
    await pool.end();
  });
  it("hides foreign records, cancels atomically and prevents late completion", async () => {
    const run = await claimRun(pool, owner, {
      platform: "kalshi",
      nativeId,
      provider: "public",
      message: "fixture",
      requestId: randomUUID(),
    });
    const input = {
      confirmed: true as const,
      requestId: randomUUID(),
      expectedRevision: 1 as const,
    };
    expect(await readRun(pool, other, run.id)).toBeNull();
    expect(await cancelRun(pool, other, run.id, input)).toBeNull();
    const results = await Promise.all([
      cancelRun(pool, owner, run.id, input),
      cancelRun(pool, owner, run.id, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.result).toEqual({ error: "CANCELLED" });
    await expect(
      finishRun(pool, owner, run.id, { reply: "late" }, "completed"),
    ).rejects.toThrow("RUN_NO_LONGER_ACTIVE");
    await expect(
      cancelRun(pool, owner, run.id, { ...input, requestId: randomUUID() }),
    ).rejects.toThrow("RUN_NO_LONGER_ACTIVE");
  });
  it("does not mutate a completed run", async () => {
    const run = await claimRun(pool, owner, {
      platform: "kalshi",
      nativeId,
      provider: "public",
      message: "fixture2",
      requestId: randomUUID(),
    });
    await finishRun(pool, owner, run.id, { reply: "fixture" }, "completed");
    await expect(
      cancelRun(pool, owner, run.id, {
        confirmed: true,
        requestId: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toThrow("RUN_NO_LONGER_ACTIVE");
    expect((await readRun(pool, owner, run.id))?.status).toBe("completed");
  });
  it("expires an abandoned run on status read so reconnect does not spin forever", async () => {
    const run = await claimRun(pool, owner, {
      platform: "kalshi",
      nativeId,
      provider: "public",
      message: "abandoned",
      requestId: randomUUID(),
    });
    await pool.query(
      "UPDATE agent_runs SET created_at=now()-interval '3 minutes' WHERE id=$1",
      [run.id],
    );
    expect((await readRun(pool, owner, run.id))?.status).toBe("failed");
    await expect(
      finishRun(pool, owner, run.id, {}, "completed"),
    ).rejects.toThrow("RUN_NO_LONGER_ACTIVE");
  });
});
