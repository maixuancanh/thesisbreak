import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createSourceWatch, listSourceWatches, recordSourceWatchSnapshot, setSourceWatchState } from "../../packages/db/src/source-watches";
import { acceptSourceWatchWebhook, pollSourceWatch } from "../../packages/integrations/src/source-watch";

describe.skipIf(!process.env.TEST_DATABASE_URL)("persisted owner source watches", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const owner = randomUUID(), other = randomUUID(), secret = "s".repeat(32);
  let id: string;
  const snapshot = (value: string) => ({ eventId: "native-event-2026", originId: "official", url: "https://publisher.test/api", contentClass: "json", value, publishedAt: null });
  const input = () => ({ eventId: "native-event-2026", originId: "official", url: "https://publisher.test/api", contentClass: "json" as const, selector: "/lineup", dependencyId: "source:official", hypothesisVersion: 1, eventEndAt: new Date(Date.now() + 86400000).toISOString() });
  beforeAll(async () => {
    for (const user of [owner, other]) await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [user]);
    id = (await createSourceWatch(pool, owner, input(), { serviceWatchId: `fixture-${owner}` })).id;
  });
  afterAll(async () => { await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner,other]]); await pool.end(); });
  it("creates baseline, deduplicates, preserves reversals and enforces ownership", async () => {
    expect((await recordSourceWatchSnapshot(pool, owner, id, snapshot("A"))).status).toBe("baseline");
    expect((await recordSourceWatchSnapshot(pool, owner, id, snapshot("A"))).status).toBe("unchanged");
    const changed = await Promise.all([recordSourceWatchSnapshot(pool, owner, id, snapshot("B")), recordSourceWatchSnapshot(pool, owner, id, snapshot("B"))]);
    expect(changed.map((c) => c.status).sort()).toEqual(["changed", "unchanged"]);
    expect((await recordSourceWatchSnapshot(pool, owner, id, snapshot("A"))).status).toBe("changed");
    expect((await recordSourceWatchSnapshot(pool, other, id, snapshot("bad"))).status).toBe("inactive");
    expect(await listSourceWatches(pool, other)).toEqual([]);
    expect(await setSourceWatchState(pool, other, id, "paused")).toBeNull();
    const events = (await pool.query("SELECT sequence,published_at FROM source_change_events WHERE watch_id=$1 ORDER BY sequence", [id])).rows;
    expect(events.map((e) => e.sequence)).toEqual([1,2]);
    expect(events.every((e) => e.published_at === null)).toBe(true);
    await expect(recordSourceWatchSnapshot(pool, owner, id, { ...snapshot("bad"), eventId: "wrong-date" })).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
  });
  it("stops polling for paused/expired watches and records failures as unavailable", async () => {
    let calls = 0;
    const config = { enabled: true, publisherHosts: ["publisher.test"], fetchText: async () => { calls++; throw Error("timeout"); } };
    await setSourceWatchState(pool, owner, id, "paused");
    expect((await pollSourceWatch(pool, owner, id, config)).status).toBe("inactive_or_not_due");
    expect(calls).toBe(0);
    await setSourceWatchState(pool, owner, id, "active");
    expect((await pollSourceWatch(pool, owner, id, config)).status).toBe("unavailable");
    expect(calls).toBe(1);
    await pool.query("UPDATE source_watches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    expect((await pollSourceWatch(pool, owner, id, config)).status).toBe("inactive_or_not_due");
    expect(calls).toBe(1);
  });
  it("rejects duplicate signed webhook and does not trust caller source identity", async () => {
    const watch = await createSourceWatch(pool, owner, input(), { serviceWatchId: `webhook-${owner}` });
    const body = JSON.stringify({ schemaVersion: 1, serviceWatchId: `webhook-${owner}`, timestamp: new Date().toISOString(), nonce: randomUUID() });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const config = { enabled: true, publisherHosts: ["publisher.test"], fetchText: async () => ({ text: JSON.stringify({ lineup: "A", ad: "noise" }), contentType: "application/json" }) };
    expect((await acceptSourceWatchWebhook(pool, body, signature, secret, config)).status).toBe("baseline");
    await expect(acceptSourceWatchWebhook(pool, body, signature, secret, config)).rejects.toThrow("SOURCE_NOTIFICATION_REPLAY");
    expect((await pool.query("SELECT snapshot_value FROM source_watches WHERE id=$1", [watch.id])).rows[0].snapshot_value).toBe("A");
  });
});
