import { createHash } from "node:crypto";
import {
  MemWal,
  type MemWalConfig,
  type RecallParams,
  type RecallResult,
  type RememberResult,
  type RestoreResult,
} from "@mysten-incubation/memwal";
import { z } from "zod";

function serverOnly() {
  if (
    typeof window !== "undefined" ||
    typeof process === "undefined" ||
    !process.versions?.node
  )
    throw new Error("MemWal requires a Node server");
}
serverOnly();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const recordSchema = z
  .object({
    logicalId: z.string().min(1),
    type: z.string().min(1),
    version: z.number().int().positive(),
    recordedAt: z.iso.datetime(),
    payload: z.json(),
  })
  .strict();
const envelopeSchema = recordSchema
  .extend({
    schema: z.literal(1),
    userId: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MemoryRecord = z.infer<typeof recordSchema>;
export type MemoryEnvelope = z.infer<typeof envelopeSchema>;
export interface MemoryClient {
  rememberAndWait(
    text: string,
    namespace: string,
    options: { idempotencyKey: string; timeoutMs: number },
  ): Promise<RememberResult>;
  recall(params: RecallParams): Promise<RecallResult>;
  restore(namespace: string, limit?: number): Promise<RestoreResult>;
  destroy(): void;
}
// Canonical JSON makes payload property order immaterial; the timestamp must be persisted by the caller.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function parseMemwalConfig(
  env: Readonly<Record<string, string | undefined>>,
): MemWalConfig {
  serverOnly();
  const config = z
    .object({
      key: z.string().trim().min(1),
      accountId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      serverUrl: z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }),
    })
    .parse({
      key: env.MEMWAL_DELEGATE_KEY,
      accountId: env.MEMWAL_ACCOUNT_ID,
      serverUrl: env.MEMWAL_RELAYER_URL ?? "https://relayer.memory.walrus.xyz",
    });
  return config;
}
export const officialMemwalClient = (config: MemWalConfig): MemoryClient => {
  serverOnly();
  return MemWal.create(config);
};
export class MemwalAdapter {
  readonly namespace: string;
  private destroyed = false;
  constructor(
    private readonly client: MemoryClient,
    private readonly userId: string,
  ) {
    serverOnly();
    if (!userId.trim()) throw new Error("Trusted server userId required");
    this.namespace = `thesisbreak-v1-${digest(userId)}`;
  }
  private active() {
    serverOnly();
    if (this.destroyed) throw new Error("MemWal adapter destroyed");
  }
  private envelope(record: MemoryRecord): MemoryEnvelope {
    const body = {
      schema: 1 as const,
      userId: this.userId,
      ...recordSchema.parse(record),
    };
    return { ...body, hash: digest(canonical(body)) };
  }
  private async recallValidated(query: string) {
    this.active();
    const response = await this.client.recall({
      query,
      namespace: this.namespace,
      limit: 20,
      maxDistance: 0.5,
    });
    const sources: { record: MemoryEnvelope; blobId: string; text: string }[] =
      [];
    let rejected = 0;
    for (const hit of response.results) {
      try {
        if (
          !Number.isFinite(hit.distance) ||
          hit.distance < 0 ||
          hit.distance >= 0.5 ||
          !hit.blob_id
        )
          throw new Error("invalid source");
        const envelope = envelopeSchema.parse(JSON.parse(hit.text));
        const { hash, ...body } = envelope;
        if (body.userId !== this.userId || digest(canonical(body)) !== hash)
          throw new Error("integrity");
        sources.push({ record: envelope, blobId: hit.blob_id, text: hit.text });
      } catch {
        rejected++;
      }
    }
    const blobText = new Map<string, string>();
    const conflictingBlobs = new Set<string>();
    for (const source of sources) {
      const previous = blobText.get(source.blobId);
      if (previous !== undefined && previous !== source.text)
        conflictingBlobs.add(source.blobId);
      blobText.set(source.blobId, source.text);
    }
    const consistentSources = sources.filter(
      (source) => !conflictingBlobs.has(source.blobId),
    );
    const records = new Map<string, MemoryEnvelope>();
    const conflicts = new Set<string>();
    for (const source of consistentSources) {
      const key = `${source.record.logicalId}@${source.record.version}`;
      const previous = records.get(key);
      if (previous && previous.hash !== source.record.hash) conflicts.add(key);
      records.set(key, source.record);
    }
    for (const key of conflicts) records.delete(key);
    return {
      observations: sources,
      records: [...records.values()],
      sources: consistentSources.filter(
        ({ record }) => !conflicts.has(`${record.logicalId}@${record.version}`),
      ),
      conflicts: [...conflicts],
      conflictingBlobs: [...conflictingBlobs],
      rejected,
      completeness: "unknown" as const,
    };
  }
  async recall(query: string) {
    const result = await this.recallValidated(query);
    return {
      records: result.records,
      sources: result.sources,
      conflicts: result.conflicts,
      conflictingBlobs: result.conflictingBlobs,
      rejected: result.rejected,
      completeness: result.completeness,
    };
  }
  async remember(record: MemoryRecord) {
    this.active();
    const expected = this.envelope(record);
    const text = canonical(expected);
    const idempotencyKey = digest(
      canonical({
        namespace: this.namespace,
        logicalId: expected.logicalId,
        version: expected.version,
      }),
    );
    try {
      const receipt = await this.client.rememberAndWait(text, this.namespace, {
        idempotencyKey,
        timeoutMs: 90000,
      });
      if (receipt.namespace !== this.namespace)
        return {
          status: "error" as const,
          reason: "receipt_namespace_mismatch",
        };
      const readback = await this.recall(text);
      if (
        readback.conflicts.includes(`${expected.logicalId}@${expected.version}`)
      )
        return { status: "error" as const, reason: "conflicting_readback" };
      const match = readback.records.find(
        (item) =>
          item.logicalId === expected.logicalId &&
          item.version === expected.version,
      );
      if (match && (match.hash !== expected.hash || canonical(match) !== text))
        return { status: "error" as const, reason: "readback_mismatch" };
      const exactBlob = readback.sources.some(
        (source) =>
          source.blobId === receipt.blob_id &&
          source.record.hash === expected.hash &&
          source.text === text,
      );
      return match && exactBlob
        ? {
            status: "verified" as const,
            hash: expected.hash,
            blobId: receipt.blob_id,
          }
        : {
            status: "pending" as const,
            reason: "exact_readback_not_found",
            blobId: receipt.blob_id,
          };
    } catch {
      return {
        status: "error" as const,
        reason: "sdk_write_or_readback_failed",
      };
    }
  }
  async restore(expectedInventory?: readonly MemoryRecord[]) {
    this.active();
    const result = await this.client.restore(this.namespace, 20);
    if (result.namespace !== this.namespace)
      throw new Error("Restore namespace mismatch");
    if (!expectedInventory)
      return {
        ...result,
        completeness:
          result.truncated || result.failed > 0
            ? ("incomplete" as const)
            : ("unknown" as const),
      };
    const expected = expectedInventory.map((record) => this.envelope(record));
    const sources: { record: MemoryEnvelope; blobId: string; text: string }[] =
      [];
    const conflictingBlobs = new Set<string>();
    const conflicts = new Set<string>();
    const blobText = new Map<string, string>();
    const recordHashes = new Map<string, string>();
    for (const envelope of expected) {
      const found = await this.recallValidated(canonical(envelope));
      for (const blobId of found.conflictingBlobs) conflictingBlobs.add(blobId);
      for (const key of found.conflicts) conflicts.add(key);
      for (const source of found.observations) {
        const previousText = blobText.get(source.blobId);
        if (previousText !== undefined && previousText !== source.text)
          conflictingBlobs.add(source.blobId);
        blobText.set(source.blobId, source.text);
        sources.push(source);
      }
    }
    const consistentSources = sources.filter(
      (source) => !conflictingBlobs.has(source.blobId),
    );
    for (const source of consistentSources) {
      const key = `${source.record.logicalId}@${source.record.version}`;
      const previousHash = recordHashes.get(key);
      if (previousHash !== undefined && previousHash !== source.record.hash)
        conflicts.add(key);
      recordHashes.set(key, source.record.hash);
    }
    const missing = expected
      .filter((envelope) => {
        const key = `${envelope.logicalId}@${envelope.version}`;
        return (
          conflicts.has(key) ||
          !consistentSources.some(
            (source) => canonical(source.record) === canonical(envelope),
          )
        );
      })
      .map((envelope) => `${envelope.logicalId}@${envelope.version}`);
    return {
      ...result,
      missing,
      completeness:
        missing.length || result.truncated || result.failed > 0
          ? ("incomplete" as const)
          : ("expected_inventory_verified" as const),
    };
  }
  destroy() {
    if (!this.destroyed) {
      this.client.destroy();
      this.destroyed = true;
    }
  }
}
