import { describe, expect, it } from "vitest";
import {
  MemwalAdapter,
  parseMemwalConfig,
  type MemoryClient,
} from "../../packages/integrations/src/memwal.js";

// Offline transport fake: this does not establish relayer or chain behavior.
function fixture() {
  const texts: string[] = [];
  const keys: string[] = [];
  let hits: { text: string; distance: number; blob_id: string }[] = [];
  let destroyed = false;
  let lastQuery: unknown;
  const client: MemoryClient = {
    async rememberAndWait(text, namespace, opts) {
      texts.push(text);
      keys.push(opts.idempotencyKey);
      return { id: "job", blob_id: "blob", owner: "owner", namespace };
    },
    async recall(params) {
      lastQuery = params;
      return { results: hits, total: hits.length };
    },
    async restore(namespace) {
      return {
        restored: 1,
        skipped: 0,
        failed: 0,
        total: 1,
        truncated: false,
        owner: "owner",
        namespace,
      };
    },
    destroy() {
      destroyed = true;
    },
  };
  const adapter = new MemwalAdapter(client, "trusted-user");
  const record = {
    logicalId: "thesis-1",
    type: "thesis",
    version: 1,
    recordedAt: "2026-10-22T00:00:00.000Z",
    payload: { thesis: "growth" },
  };
  return {
    adapter,
    record,
    texts,
    keys,
    get query() {
      return lastQuery;
    },
    get destroyed() {
      return destroyed;
    },
    setHits(values: typeof hits) {
      hits = values;
    },
  };
}
describe("offline MemWal adapter", () => {
  it("requires explicit credentials and maps only its own environment", () => {
    expect(() => parseMemwalConfig({})).toThrow();
    expect(
      parseMemwalConfig({
        MEMWAL_DELEGATE_KEY: "key",
        MEMWAL_ACCOUNT_ID: "0x" + "a".repeat(64),
        MEMWAL_RELAYER_URL: "https://relayer.memory.walrus.xyz",
      }),
    ).toEqual({
      key: "key",
      accountId: "0x" + "a".repeat(64),
      serverUrl: "https://relayer.memory.walrus.xyz",
    });
    expect(() =>
      parseMemwalConfig({
        MEMWAL_DELEGATE_KEY: "key",
        MEMWAL_ACCOUNT_ID: "bad",
      }),
    ).toThrow();
  });
  it("keeps missing readback pending and retry keys stable; exact readback verifies", async () => {
    const f = fixture();
    expect((await f.adapter.remember(f.record)).status).toBe("pending");
    f.setHits([{ text: f.texts[0]!, distance: 0, blob_id: "blob" }]);
    expect((await f.adapter.remember(f.record)).status).toBe("verified");
    expect(f.keys[0]).toBe(f.keys[1]);
    expect(f.query).toMatchObject({
      limit: 20,
      maxDistance: 0.5,
      namespace: f.adapter.namespace,
    });
    expect(f.adapter.namespace).not.toContain("trusted-user");
  });
  it("rejects malformed, wrong-user, corrupted and distant hits", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    const envelope = JSON.parse(f.texts[0]!);
    f.setHits([
      { text: "invalid", distance: 0, blob_id: "a" },
      {
        text: JSON.stringify({ ...envelope, userId: "attacker" }),
        distance: 0,
        blob_id: "b",
      },
      {
        text: JSON.stringify({ ...envelope, hash: "bad" }),
        distance: 0,
        blob_id: "c",
      },
      { text: f.texts[0]!, distance: 0.5, blob_id: "d" },
    ]);
    expect((await f.adapter.recall("growth")).records).toEqual([]);
  });
  it("deduplicates identical records and excludes conflicting versions", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    const first = f.texts[0]!;
    await f.adapter.remember({ ...f.record, payload: { thesis: "other" } });
    f.setHits([
      { text: first, distance: 0, blob_id: "a" },
      { text: first, distance: 0, blob_id: "b" },
    ]);
    expect((await f.adapter.recall("growth")).records).toHaveLength(1);
    f.setHits([
      { text: first, distance: 0, blob_id: "a" },
      { text: f.texts[1]!, distance: 0, blob_id: "c" },
    ]);
    expect((await f.adapter.recall("growth")).records).toEqual([]);
    expect((await f.adapter.remember(f.record)).status).toBe("error");
  });
  it("does not infer recovery completeness and destroys keys on cleanup", async () => {
    const f = fixture();
    expect(await f.adapter.restore()).toMatchObject({
      completeness: "unknown",
      restored: 1,
    });
    expect(await f.adapter.restore([f.record])).toMatchObject({
      completeness: "incomplete",
      missing: ["thesis-1@1"],
    });
    f.adapter.destroy();
    expect(f.destroyed).toBe(true);
    await expect(f.adapter.recall("x")).rejects.toThrow("destroyed");
  });
});

// Separate failure transport keeps tests independent of live infrastructure.
describe("MemWal failure boundary", () => {
  it("contains transport errors without returning secret-bearing error text", async () => {
    const client: MemoryClient = {
      async rememberAndWait() {
        throw new Error("secret credential material");
      },
      async recall() {
        throw new Error("unexpected");
      },
      async restore() {
        throw new Error("unexpected");
      },
      destroy() {},
    };
    const adapter = new MemwalAdapter(client, "user");
    const result = await adapter.remember({
      logicalId: "x",
      type: "thesis",
      version: 1,
      recordedAt: "2026-10-22T00:00:00Z",
      payload: {},
    });
    expect(result).toEqual({
      status: "error",
      reason: "sdk_write_or_readback_failed",
    });
  });
  it("only verifies explicit expected recovery inventory after exact readback", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    f.setHits([{ text: f.texts[0]!, distance: 0, blob_id: "blob" }]);
    expect(await f.adapter.restore([f.record])).toMatchObject({
      completeness: "expected_inventory_verified",
      missing: [],
    });
  });
});

describe("MemWal canonical and receipt regression", () => {
  it("uses ordinal nested key order without Unicode normalization", async () => {
    const f = fixture();
    await f.adapter.remember({
      ...f.record,
      payload: { z: 1, A: 2, a: 3, é: 4, é: 5 },
    });
    expect(f.texts[0]).toContain('"payload":{"A":2,"a":3,"é":5,"z":1,"é":4}');
  });
  it("does not verify a receipt using an older identical blob", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    f.setHits([{ text: f.texts[0]!, distance: 0, blob_id: "older-blob" }]);
    expect((await f.adapter.remember(f.record)).status).toBe("pending");
    f.setHits([
      { text: f.texts[0]!, distance: 0, blob_id: "older-blob" },
      { text: f.texts[0]!, distance: 0, blob_id: "blob" },
    ]);
    expect((await f.adapter.remember(f.record)).status).toBe("verified");
  });
  it("requires the receipt blob's exact serialized text", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    f.setHits([
      {
        text: JSON.stringify(JSON.parse(f.texts[0]!), null, 2),
        distance: 0,
        blob_id: "blob",
      },
    ]);
    expect((await f.adapter.remember(f.record)).status).toBe("pending");
  });
});

describe("MemWal blob source consistency", () => {
  it("rejects a blob reported with multiple valid plaintexts across logical records", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    await f.adapter.remember({ ...f.record, logicalId: "thesis-2" });
    f.setHits([
      { text: f.texts[0]!, distance: 0, blob_id: "blob" },
      { text: f.texts[1]!, distance: 0, blob_id: "blob" },
    ]);
    expect((await f.adapter.recall("growth")).records).toEqual([]);
    expect((await f.adapter.remember(f.record)).status).not.toBe("verified");
    expect(await f.adapter.restore([f.record])).toMatchObject({
      completeness: "incomplete",
      missing: ["thesis-1@1"],
    });
  });
  it("preserves an independently consistent blob copy when another source conflicts", async () => {
    const f = fixture();
    await f.adapter.remember(f.record);
    await f.adapter.remember({ ...f.record, logicalId: "thesis-2" });
    f.setHits([
      { text: f.texts[0]!, distance: 0, blob_id: "bad" },
      { text: f.texts[1]!, distance: 0, blob_id: "bad" },
      { text: f.texts[0]!, distance: 0, blob_id: "blob" },
    ]);
    const recalled = await f.adapter.recall("growth");
    expect(recalled.records).toHaveLength(1);
    expect(recalled.records[0]?.logicalId).toBe("thesis-1");
    expect(recalled.sources.map((source) => source.blobId)).toEqual(["blob"]);
    expect((await f.adapter.remember(f.record)).status).toBe("verified");
  });
});

describe("MemWal recovery source consistency across queries", () => {
  it("quarantines a blob that changes plaintext between separate inventory recalls", async () => {
    const f = fixture();
    const second = { ...f.record, logicalId: "thesis-2" };
    await f.adapter.remember(f.record);
    await f.adapter.remember(second);
    let round = 0;
    const client: MemoryClient = {
      async rememberAndWait() {
        throw new Error("unused");
      },
      async recall() {
        return {
          results: [
            { text: f.texts[round++ % 2]!, distance: 0, blob_id: "shared" },
          ],
          total: 1,
        };
      },
      async restore(namespace) {
        return {
          namespace,
          owner: "owner",
          restored: 2,
          skipped: 0,
          failed: 0,
          total: 2,
          truncated: false,
        };
      },
      destroy() {},
    };
    const adapter = new MemwalAdapter(client, "trusted-user");
    expect(await adapter.restore([f.record, second])).toMatchObject({
      completeness: "incomplete",
      missing: ["thesis-1@1", "thesis-2@1"],
    });
  });
  it("retains independent consistent copies after cross-query blob quarantine", async () => {
    const f = fixture();
    const second = { ...f.record, logicalId: "thesis-2" };
    await f.adapter.remember(f.record);
    await f.adapter.remember(second);
    let round = 0;
    const client: MemoryClient = {
      async rememberAndWait() {
        throw new Error("unused");
      },
      async recall() {
        const index = round++ % 2;
        return {
          results: [
            { text: f.texts[index]!, distance: 0, blob_id: "shared" },
            {
              text: f.texts[index]!,
              distance: 0,
              blob_id: `independent-${index}`,
            },
          ],
          total: 2,
        };
      },
      async restore(namespace) {
        return {
          namespace,
          owner: "owner",
          restored: 2,
          skipped: 0,
          failed: 0,
          total: 2,
          truncated: false,
        };
      },
      destroy() {},
    };
    const adapter = new MemwalAdapter(client, "trusted-user");
    expect(await adapter.restore([f.record, second])).toMatchObject({
      completeness: "expected_inventory_verified",
      missing: [],
    });
  });
});
