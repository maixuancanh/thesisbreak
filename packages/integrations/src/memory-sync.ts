import type { MemoryRecord } from "./memwal";
export type MemorySyncResult =
  | { status: "verified"; hash: string; blobId: string }
  | { status: "retry"; reason: string };
export interface MemoryWriter {
  remember(
    record: MemoryRecord,
  ): Promise<{
    status: string;
    hash?: string;
    blobId?: string;
    reason?: string;
  }>;
}
export async function processMemoryClaim(
  claim: { userId: string; record: MemoryRecord },
  adapter: MemoryWriter,
  timeoutMs = 95000,
): Promise<MemorySyncResult> {
  if (
    !claim.record.payload ||
    typeof claim.record.payload !== "object" ||
    Array.isArray(claim.record.payload) ||
    claim.record.payload.userId !== claim.userId
  )
    return { status: "retry", reason: "owner_mismatch" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      adapter.remember(claim.record),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    if (
      result.status === "verified" &&
      /^[a-f0-9]{64}$/.test(result.hash ?? "") &&
      result.blobId
    )
      return { status: "verified", hash: result.hash!, blobId: result.blobId };
    return { status: "retry", reason: result.reason ?? "unverified" };
  } catch (error) {
    return {
      status: "retry",
      reason:
        error instanceof Error && error.message === "timeout"
          ? "timeout"
          : "adapter_failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
