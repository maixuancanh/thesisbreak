import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  createChatSession,
  chatHistory,
  listChatSessions,
  recallChatMemories,
  conversationLogicalId,
} from "../../packages/db/src/chat-sessions";
import type { MemwalAdapter } from "../../packages/integrations/src/memwal";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "independent chat sessions",
  () => {
    it("keeps multiple markets in one session, separates new sessions, rejects another owner and checkpoints consented turns", async () => {
      const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      const owner = randomUUID(),
        other = randomUUID();
      const markets = [`SESSION-${randomUUID()}`, `SESSION-${randomUUID()}`];
      try {
        for (const id of [owner, other])
          await p.query(
            "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
            [id],
          );
        const a = await createChatSession(p, owner, true),
          b = await createChatSession(p, owner, true);
        for (const nativeId of markets) {
          const run = await claimRun(p, owner, {
            sessionId: a.id,
            platform: "kalshi",
            nativeId,
            provider: "public",
            message: `Reason for ${nativeId}`,
            requestId: randomUUID(),
          });
          await finishRun(
            p,
            owner,
            run.id,
            {
              reply: { message: "Noted." },
              sources: [],
              marketQuestion: nativeId,
            },
            "completed",
          );
        }
        expect(
          (await chatHistory(p, owner, a.id)).map((r) => r.native_id),
        ).toEqual(markets);
        expect(await chatHistory(p, owner, b.id)).toEqual([]);
        await expect(chatHistory(p, other, a.id)).rejects.toThrow(
          "SESSION_NOT_FOUND",
        );
        await expect(
          claimRun(p, other, {
            sessionId: a.id,
            platform: "kalshi",
            nativeId: markets[0]!,
            provider: "public",
            message: "foreign",
            requestId: randomUUID(),
          }),
        ).rejects.toThrow("SESSION_NOT_FOUND");
        const mem = (
          await p.query(
            "SELECT version,payload FROM conversation_memories WHERE conversation_id=$1 ORDER BY version",
            [a.id],
          )
        ).rows;
        expect(mem).toHaveLength(2);
        expect(mem[0].payload.turns).toHaveLength(1);
        expect(mem[1].payload.turns).toHaveLength(2);
        expect(await listChatSessions(p, other)).toEqual([]);
        const row = (
          await p.query(
            "UPDATE conversation_memories SET state='verified',hash='verified-hash',blob_id='verified-blob' WHERE conversation_id=$1 AND version=2 RETURNING payload,recorded_at",
            [a.id],
          )
        ).rows[0];
        const hit = {
          blobId: "verified-blob",
          record: {
            logicalId: conversationLogicalId(row.payload),
            version: 2,
            type: "conversation.session",
            hash: "verified-hash",
            recordedAt: row.recorded_at.toISOString(),
            payload: row.payload,
          },
        };
        let returned = hit;
        const adapter = {
          recall: async () => ({ sources: [returned] }),
        } as unknown as MemwalAdapter;
        expect(
          await recallChatMemories(p, adapter, owner, b.id, "Reason"),
        ).toHaveLength(1);
        expect(
          await recallChatMemories(p, adapter, other, b.id, "Reason"),
        ).toEqual([]);
        expect(
          await recallChatMemories(p, adapter, owner, a.id, "Reason"),
        ).toEqual([]);
        returned = { ...hit, record: { ...hit.record, version: 1 } };
        expect(
          await recallChatMemories(p, adapter, owner, b.id, "Reason"),
        ).toEqual([]);
        returned = {
          ...hit,
          record: {
            ...hit.record,
            payload: { ...hit.record.payload, title: "altered" },
          },
        };
        expect(
          await recallChatMemories(p, adapter, owner, b.id, "Reason"),
        ).toEqual([]);
        returned = hit;
        await p.query(
          "UPDATE conversations SET memory_consent=false WHERE id=$1",
          [a.id],
        );
        expect(
          await recallChatMemories(p, adapter, owner, b.id, "Reason"),
        ).toEqual([]);
      } finally {
        await p.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
        await p.query("DELETE FROM markets WHERE native_id=ANY($1)", [markets]);
        await p.end();
      }
    });
  },
);

it.skipIf(!process.env.TEST_DATABASE_URL)(
  "retains early segments when the same session grows beyond its first twenty turns",
  async () => {
    const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      owner = randomUUID();
    try {
      await p.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        owner,
      ]);
      const a = await createChatSession(p, owner, true),
        b = await createChatSession(p, owner, false);
      for (let i = 0; i < 21; i++) {
        const r = await claimRun(p, owner, {
          sessionId: a.id,
          platform: "kalshi",
          nativeId: "SESSION-LONG",
          provider: "public",
          message: `Reason number ${i}`,
          requestId: randomUUID(),
        });
        await finishRun(
          p,
          owner,
          r.id,
          {
            reply: { message: "Noted." },
            marketQuestion: "Market",
            sources: [],
          },
          "completed",
        );
      }
      const rows = (
        await p.query(
          "SELECT version,payload,recorded_at FROM conversation_memories WHERE conversation_id=$1 ORDER BY version",
          [a.id],
        )
      ).rows;
      expect(rows[19].payload.turns).toHaveLength(20);
      expect(rows[20].payload.turns).toHaveLength(1);
      expect(rows[20].payload.segment).toBe(1);
      await p.query(
        "UPDATE conversation_memories SET state='verified',hash='h',blob_id='b' WHERE conversation_id=$1 AND version=ANY($2)",
        [a.id, [20, 21]],
      );
      const adapter = {
        recall: async () => ({
          sources: [
            {
              blobId: "b",
              record: {
                type: "conversation.session",
                logicalId: conversationLogicalId(rows[19].payload),
                version: 20,
                hash: "h",
                recordedAt: rows[19].recorded_at.toISOString(),
                payload: rows[19].payload,
              },
            },
          ],
        }),
      } as unknown as MemwalAdapter;
      const recalled = await recallChatMemories(
        p,
        adapter,
        owner,
        b.id,
        "Reason number 0",
      );
      expect(recalled).toHaveLength(1);
      expect(recalled[0]?.payload.segment).toBe(0);
    } finally {
      await p.query("DELETE FROM users WHERE id=$1", [owner]);
      await p.query("DELETE FROM markets WHERE native_id='SESSION-LONG'");
      await p.end();
    }
  },
);
