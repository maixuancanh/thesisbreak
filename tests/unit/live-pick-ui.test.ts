import { describe, it, expect } from "vitest";
import {
  draftKey,
  pickSaveResultSchema,
  readPickReceipt,
  pickReceiptKey,
  readDraft,
  retryIdentity,
  pickPayload,
  liveMarketPath,
  friendlyDate,
  providerLabel,
} from "../../apps/web/lib/live-market";
describe("live pick identity and drafts", () => {
  it("keeps exact native identity and chosen source in a create payload", () => {
    expect(
      pickPayload("kalshi", "EXACT-ID", "tatum", "No", "  reason  "),
    ).toEqual({
      platform: "kalshi",
      nativeId: "EXACT-ID",
      provider: "tatum",
      outcome: "No",
      reason: "reason",
    });
    expect(
      liveMarketPath({ platform: "kalshi", id: "EXACT/ID" }, "tatum"),
    ).toBe("/live-market/kalshi/EXACT%2FID?provider=tatum");
  });
  it("reuses request IDs only for identical payload retries", () => {
    let calls = 0;
    const uuid = () => String(++calls);
    const a = retryIdentity(null, { outcome: "Yes", reason: "" }, uuid);
    expect(retryIdentity(a, { outcome: "Yes", reason: "" }, uuid)).toBe(a);
    expect(
      retryIdentity(a, { outcome: "No", reason: "" }, uuid).requestId,
    ).not.toBe(a.requestId);
    expect(calls).toBe(2);
  });
  it("isolates provider/platform drafts and rejects foreign or oversized records", () => {
    expect(draftKey("kalshi", "id", "public")).not.toBe(
      draftKey("kalshi", "id", "tatum"),
    );
    expect(draftKey("kalshi", "id", "public")).not.toBe(
      draftKey("polymarket", "id", "public"),
    );
    expect(
      readDraft(JSON.stringify({ outcome: "", reason: "", composer: "" })),
    ).toEqual({ outcome: "", reason: "", composer: "" });
    expect(
      readDraft(
        JSON.stringify({
          outcome: "Yes",
          reason: "x".repeat(4001),
          composer: "",
        }),
      ),
    ).toBeNull();
    expect(readDraft('{"sample":true}')).toBeNull();
    expect(readDraft("broken")).toBeNull();
  });
  it("formats safe dates and human source names", () => {
    expect(friendlyDate("bad")).toBe("Unavailable");
    expect(friendlyDate("2026-10-22T00:00:00Z")).not.toBe(
      "2026-10-22T00:00:00Z",
    );
    expect(providerLabel("kalshi-public")).toBe("Kalshi public API");
  });
  it("restores pending retries and saved receipts only for the same user and exact payload", () => {
    const payload = pickPayload("kalshi", "EXACT-ID", "public", "Yes", "");
    const receipt = {
      userId: "account-A",
      payload,
      requestId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
      saved: false,
    };
    const raw = JSON.stringify(receipt);
    expect(readPickReceipt(raw, "account-A", payload)?.requestId).toBe(
      receipt.requestId,
    );
    expect(
      readPickReceipt(
        JSON.stringify({ ...receipt, saved: true }),
        "account-A",
        payload,
      )?.saved,
    ).toBe(true);
    expect(readPickReceipt(raw, "account-B", payload)).toBeNull();
    expect(
      readPickReceipt(raw, "account-A", { ...payload, outcome: "No" }),
    ).toBeNull();
    expect(
      readPickReceipt(raw, "account-A", { ...payload, provider: "tatum" }),
    ).toBeNull();
    expect(
      readPickReceipt(
        JSON.stringify({ ...receipt, foreign: true }),
        "account-A",
        payload,
      ),
    ).toBeNull();
    expect(
      readPickReceipt(
        JSON.stringify({ ...receipt, requestId: "invalid" }),
        "account-A",
        payload,
      ),
    ).toBeNull();
    expect(pickReceiptKey("market", "account-A")).not.toBe(
      pickReceiptKey("market", "account-B"),
    );
  });
  it("requires a real save receipt before showing success", () => {
    expect(pickSaveResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(
      pickSaveResultSchema.safeParse({
        pickId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
        version: 1,
      }).success,
    ).toBe(true);
  });
});
