import { describe, expect, it } from "vitest";
import { processMemoryClaim } from "../../packages/integrations/src/memory-sync";
import type { Pool } from "pg";
import {
  claimMemoryOutbox,
  lessonRowToPayload,
} from "../../packages/db/src/memory-outbox";
const record = {
  logicalId: "lesson:u:l:1",
  type: "lesson",
  version: 1,
  recordedAt: "2026-01-01T00:00:00.000Z",
  payload: { userId: "u" },
};
describe("memory sync", () => {
  it("converts thrown transport errors into retry", async () => {
    expect(
      await processMemoryClaim(
        { userId: "u", record },
        {
          remember: async () => {
            throw new Error("network");
          },
        },
        20,
      ),
    ).toEqual({ status: "retry", reason: "adapter_failed" });
  });
  it("retries pending readback without declaring success", async () => {
    const result = await processMemoryClaim(
      { userId: "u", record },
      { remember: async () => ({ status: "pending", reason: "missing" }) },
      20,
    );
    expect(result.status).toBe("retry");
  });
  it("bounds hung adapters", async () => {
    const result = await processMemoryClaim(
      { userId: "u", record },
      { remember: () => new Promise(() => {}) },
      5,
    );
    expect(result).toEqual({ status: "retry", reason: "timeout" });
  });
  it("rejects cross owner payloads before remote calls", async () => {
    let writes = 0;
    const result = await processMemoryClaim(
      { userId: "other", record },
      {
        remember: async () => {
          writes++;
          return { status: "verified", hash: "a".repeat(64), blobId: "blob" };
        },
      },
      20,
    );
    expect(result.status).toBe("retry");
    expect(writes).toBe(0);
  });
  it("retains timestamp and record across retries", async () => {
    const seen: unknown[] = [];
    const adapter = {
      remember: async (value: unknown) => {
        seen.push(value);
        return { status: "pending" as const, reason: "missing" };
      },
    };
    await processMemoryClaim({ userId: "u", record }, adapter, 20);
    await processMemoryClaim({ userId: "u", record }, adapter, 20);
    expect(seen).toEqual([record, record]);
  });
  it("accepts only verified hash and blob receipts", async () => {
    expect(
      await processMemoryClaim(
        { userId: "u", record },
        {
          remember: async () => ({
            status: "verified",
            hash: "a".repeat(64),
            blobId: "blob",
          }),
        },
        20,
      ),
    ).toEqual({ status: "verified", hash: "a".repeat(64), blobId: "blob" });
  });
  it("maps null optional lesson fields by omission", () => {
    const value = lessonRowToPayload({
      lesson_id: "l",
      user_id: "u",
      version: 1,
      parent_version: null,
      rule: "Check source",
      scope: { domain: "politics" },
      approval: "approved",
      status: "active",
      effective_at: new Date(record.recordedAt),
      expires_at: null,
      review_at: null,
      superseded_by: null,
      originating_correction: null,
    });
    expect(value).not.toHaveProperty("reviewAt");
    expect(value).not.toHaveProperty("originatingCorrection");
  });
});

it("drains a blocked stale event before reporting a truly empty queue", async () => {
  let reads = 0;
  const queries: string[] = [];
  const client = {
    release() {},
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SELECT * FROM outbox")) {
        reads++;
        return {
          rows:
            reads === 1
              ? [
                  {
                    operation_key: "stale",
                    user_id: "u",
                    payload: { lessonId: "l", version: 1 },
                    created_at: new Date(),
                    attempts: 0,
                  },
                ]
              : [],
        };
      }
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  expect(await claimMemoryOutbox(pool)).toBeNull();
  expect(reads).toBe(2);
  expect(queries.filter((q) => q.includes("state='blocked'"))).toHaveLength(1);
});
it("blocks malformed consented payloads before querying a typed version", async () => {
  let reads = 0;
  const queries: string[] = [];
  const client = {
    release() {},
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SELECT * FROM outbox")) {
        reads++;
        return {
          rows:
            reads === 1
              ? [
                  {
                    operation_key: "invalid",
                    user_id: "u",
                    payload: { lessonId: {}, version: "bad" },
                    attempts: 0,
                  },
                ]
              : [],
        };
      }
      return { rows: [] };
    },
  };
  expect(
    await claimMemoryOutbox({ connect: async () => client } as unknown as Pool),
  ).toBeNull();
  expect(reads).toBe(2);
  expect(queries.some((q) => q.startsWith("SELECT v.*"))).toBe(false);
});
