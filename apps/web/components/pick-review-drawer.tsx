"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { safeEvidenceUrl, type PickReview } from "../lib/pick-review-client";
export function PickReviewDrawer({
  review,
  affected,
  onClose,
  onSelect,
  onSuccess,
  onDiscuss,
}: {
  review: PickReview | null;
  affected: PickReview[];
  onClose: () => void;
  onSelect: (r: PickReview) => void;
  onSuccess: () => void;
  onDiscuss: (r: PickReview) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const request = useRef<{ body: string; id: string } | null>(null);
  useEffect(() => {
    setError("");
    setMessage("");
    request.current = null;
  }, [review?.id]);
  async function act(action: "keep" | "update" | "stop_watching") {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    const body = {
      assessmentId: review.id,
      basePickVersion: review.pickVersion,
      reasonRevision: review.reasonRevision,
      action,
      confirmed: true,
    };
    const serialized = JSON.stringify(body);
    if (request.current?.body !== serialized)
      request.current = { body: serialized, id: crypto.randomUUID() };
    try {
      const r = await fetch(
        `/api/reviews/${encodeURIComponent(review.id)}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, requestId: request.current.id }),
        },
      );
      const result = await r.json().catch(() => null);
      if (!r.ok)
        throw Error(
          result?.error === "MONITORING_CONSENT_REQUIRED"
            ? "Monitoring consent has changed. Review your consent in Memory, or stop watching this pick."
            : r.status === 409
              ? "This pick or review changed in another tab. Close this review and refresh Today before deciding."
              : r.status === 401
                ? "Sign in again before confirming a decision."
                : "Your decision could not be saved. Retry safely.",
        );
      if (!["recorded", "proposal_required"].includes(result?.status))
        throw Error(
          "Decision confirmation is unavailable. Retry this request to check it safely.",
        );
      if (result?.status === "proposal_required") {
        setMessage(
          "Your pick is unchanged. Discuss an updated view with Thesis, then review and confirm its proposal.",
        );
      } else {
        setMessage(
          action === "keep"
            ? "Your decision to keep this pick was recorded."
            : "Monitoring stopped for this pick. Other picks are unchanged.",
        );
        onSuccess();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={!!review}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="pick-review-drawer"
        onCloseAutoFocus={() => {
          setError("");
          setMessage("");
          request.current = null;
        }}
      >
        <DialogTitle>Review your pick</DialogTitle>
        <DialogDescription>
          Inspect the evidence, then choose what to do. A source change does not
          change your pick.
        </DialogDescription>
        {review && (
          <>
            <h3>{review.question ?? "Your saved pick"}</h3>
            <section>
              <h4>You expected</h4>
              <p>{review.userText}</p>
            </section>
            <section>
              <h4>What changed</h4>
              <p>{review.explanation}</p>
              <details>
                <summary>View evidence</summary>
                {review.beforeExcerpt && (
                  <>
                    <h5>Before</h5>
                    <p style={{ whiteSpace: "pre-wrap" }}>
                      {review.beforeExcerpt}
                    </p>
                  </>
                )}
                {review.afterExcerpt && (
                  <>
                    <h5>After</h5>
                    <p style={{ whiteSpace: "pre-wrap" }}>
                      {review.afterExcerpt}
                    </p>
                  </>
                )}
                {safeEvidenceUrl(review.sourceUrl) && (
                  <a
                    className="text-link"
                    href={safeEvidenceUrl(review.sourceUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open source report ↗
                  </a>
                )}
                <p className="small muted">
                  Evidence check: {review.evidenceState}. Before:{" "}
                  {review.beforeRefs.length} references; after:{" "}
                  {review.afterRefs.length} references.
                </p>
              </details>
            </section>
            <section>
              <h4>Your affected picks</h4>
              <ul>
                {affected.map((p) => (
                  <li key={p.id}>
                    <Button
                      variant="link"
                      disabled={busy}
                      onClick={() => onSelect(p)}
                    >
                      {p.question ?? "Saved pick"} · version {p.pickVersion}
                    </Button>
                    {p.id === review.id ? " · selected" : ""}
                  </li>
                ))}
              </ul>
              <p className="small muted">
                Your decision applies only to the selected pick.
              </p>
            </section>
            <section>
              <h4>What is still unknown</h4>
              <p>
                {review.state === "check_unavailable"
                  ? "We couldn’t check this source. Your pick is unchanged."
                  : review.state === "waiting_confirmation"
                    ? "Waiting for confirmation from the required source."
                    : review.conditionMet === null
                      ? "The revisit condition has not been verified."
                      : "This evidence does not establish whether your pick will win."}
              </p>
            </section>
            {error && (
              <p role="alert" className="connection">
                {error}
              </p>
            )}
            {message && <p role="status">{message}</p>}
            <div className="review-actions">
              <Button
                disabled={busy || !!message}
                onClick={() => void act("keep")}
              >
                Keep my pick
              </Button>
              <Button
                variant="outline"
                disabled={busy || !!message}
                onClick={() => void act("update")}
              >
                Update my view
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !!message}
                onClick={() => void act("stop_watching")}
              >
                Stop watching
              </Button>
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onDiscuss(review)}
            >
              Discuss with Thesis
            </Button>
            <Link className="text-link" href="/picks">
              Open My picks
            </Link>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
