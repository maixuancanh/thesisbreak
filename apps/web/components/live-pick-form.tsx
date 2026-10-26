"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { conditionTitle, validMarketDraft } from "../lib/event-presentation";
import { Button } from "./ui/button";
import {
  draftKey,
  pickSaveResultSchema,
  readPickReceipt,
  pickReceiptKey,
  pickPayload,
  retryIdentity,
  type LiveMarket,
  type LiveProvider,
} from "../lib/live-market";
export function LivePickForm({
  market,
  provider,
  initialOutcome = "",
  compact = false,
  initialReason,
}: {
  market: LiveMarket;
  provider: LiveProvider;
  initialOutcome?: string | undefined;
  compact?: boolean;
  initialReason?: string;
}) {
  const key = draftKey(market.platform, market.id, provider);
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState("checking");
  const [userId, setUserId] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<{ payload: string; requestId: string } | null>(null);
  useEffect(() => {
    try {
      const d = validMarketDraft(sessionStorage.getItem(key), market);
      if (d) {
        setOutcome(initialOutcome || d.outcome);
        setReason(d.reason);
      }
    } catch {}
    if (
      initialOutcome &&
      market.outcomes.some((o) => o.name === initialOutcome)
    )
      setOutcome(initialOutcome);
    if (initialReason !== undefined) setReason(initialReason);
    setReady(true);
    const c = new AbortController();
    void fetch("/api/auth/status", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        const a = await r.json();
        if (c.signal.aborted) return;
        setUserId(typeof a.userId === "string" ? a.userId : "");
        setAuth(
          r.ok && a.configured && a.authenticated
            ? "ready"
            : r.ok && a.configured
              ? "signin"
              : "unavailable",
        );
      })
      .catch(() => {
        if (!c.signal.aborted) setAuth("unavailable");
      });
    return () => c.abort();
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try {
      const d = validMarketDraft(sessionStorage.getItem(key), market);
      sessionStorage.setItem(
        key,
        JSON.stringify({ outcome, reason, composer: d?.composer ?? "" }),
      );
    } catch {}
  }, [key, outcome, reason, ready]);
  useEffect(() => {
    if (!ready || !userId) return;
    try {
      const payload = pickPayload(
        market.platform,
        market.id,
        provider,
        outcome,
        reason,
      );
      const receipt = readPickReceipt(
        sessionStorage.getItem(pickReceiptKey(key, userId)),
        userId,
        payload,
      );
      if (receipt) {
        request.current = {
          payload: JSON.stringify(payload),
          requestId: receipt.requestId,
        };
        setSaved(receipt.saved);
      }
    } catch {}
  }, [
    ready,
    userId,
    key,
    market.platform,
    market.id,
    provider,
    outcome,
    reason,
  ]);
  useEffect(() => {
    if (
      initialOutcome &&
      market.outcomes.some((o) => o.name === initialOutcome)
    ) {
      setOutcome(initialOutcome);
      setReview(false);
      setSaved(false);
    }
  }, [initialOutcome, market]);
  async function save() {
    if (busy || auth !== "ready") return;
    setBusy(true);
    setMessage("");
    const payload = pickPayload(
      market.platform,
      market.id,
      provider,
      outcome,
      reason,
    );
    try {
      const status = await fetch("/api/auth/status", { cache: "no-store" });
      const account = await status.json();
      if (!status.ok || !account.authenticated) {
        setAuth(
          status.status === 401 || account.configured
            ? "signin"
            : "unavailable",
        );
        throw new Error("Account could not be verified. Your draft is kept.");
      }
      const currentUser =
        typeof account.userId === "string" ? account.userId : "";
      if (currentUser !== userId) {
        request.current = null;
        setUserId(currentUser);
        setReview(false);
        throw new Error(
          "Account changed. Review this pick again before saving.",
        );
      }
      if (currentUser) {
        const receipt = readPickReceipt(
          sessionStorage.getItem(pickReceiptKey(key, currentUser)),
          currentUser,
          payload,
        );
        if (receipt?.saved) {
          setSaved(true);
          setReview(false);
          return;
        }
        if (receipt)
          request.current = {
            payload: JSON.stringify(payload),
            requestId: receipt.requestId,
          };
      }
      request.current = retryIdentity(request.current, payload, () =>
        crypto.randomUUID(),
      );
      if (currentUser)
        sessionStorage.setItem(
          pickReceiptKey(key, currentUser),
          JSON.stringify({
            userId: currentUser,
            payload,
            requestId: request.current.requestId,
            saved: false,
          }),
        );
      const r = await fetch("/api/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          requestId: request.current.requestId,
        }),
      });
      if (!r.ok) {
        if (r.status === 401) setAuth("signin");
        throw new Error(
          r.status === 401
            ? "Sign in again to save."
            : "Pick could not be saved. Your draft is kept; retry this request.",
        );
      }
      if (!pickSaveResultSchema.safeParse(await r.json()).success)
        throw new Error(
          "Save confirmation was unavailable. Retry this request to check it safely.",
        );
      if (currentUser) {
        try {
          sessionStorage.setItem(
            pickReceiptKey(key, currentUser),
            JSON.stringify({
              userId: currentUser,
              payload,
              requestId: request.current.requestId,
              saved: true,
            }),
          );
        } catch {}
      }
      setSaved(true);
      setReview(false);
      setMessage("Pick saved to your account.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Save unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{compact ? "Your pick" : "Your view"}</h2>
      {!compact && (
        <p>
          Choose your own outcome. Market prices are separate from your view.
        </p>
      )}
      <label htmlFor="pick-outcome">Your outcome</label>
      <select
        id="pick-outcome"
        value={outcome}
        disabled={busy}
        onChange={(e) => {
          setOutcome(e.target.value);
          setReview(false);
          setSaved(false);
        }}
      >
        <option value="">Choose an outcome</option>
        {market.outcomes.map((o, i) => (
          <option key={i} value={o.name}>
            {o.name}
          </option>
        ))}
      </select>
      <label htmlFor="pick-reason">Your reason (optional)</label>
      <textarea
        id="pick-reason"
        maxLength={4000}
        value={reason}
        disabled={busy}
        onChange={(e) => {
          setReason(e.target.value);
          setReview(false);
          setSaved(false);
        }}
        placeholder="Why this outcome? What would make you reconsider?"
      />
      {!compact && (
        <p className="small muted">
          {reason.length}/4000 · Draft stays in this browser tab.
        </p>
      )}
      {auth === "checking" ? (
        <p role="status">Checking account...</p>
      ) : auth !== "ready" ? (
        <p>
          {auth === "signin"
            ? "Sign in to save."
            : "Saving isn’t available yet. Your draft is kept."}{" "}
          <Link className="text-link" href="/account">
            Account
          </Link>
        </p>
      ) : saved ? (
        <Link className="text-link" href="/picks">
          View My picks
        </Link>
      ) : review ? (
        <div className="context">
          <h3>Review your pick</h3>
          {market.eventTitle && <p className="lead">{market.eventTitle}</p>}
          <details className="small muted">
            <summary>Source details</summary>
            {market.platform} · {market.id}
          </details>
          <p>{conditionTitle(market)}</p>
          <strong>{outcome}</strong>
          <p style={{ whiteSpace: "pre-wrap" }}>
            {reason.trim() || "No reason added."}
          </p>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving..." : "Confirm and save pick"}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setReview(false)}
          >
            Edit
          </Button>
        </div>
      ) : (
        <Button
          disabled={
            !ready ||
            !outcome ||
            !market.outcomes.some((o) => o.name === outcome)
          }
          onClick={() => setReview(true)}
        >
          Review pick
        </Button>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
