"use client";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
const status = z.enum([
  "submitted",
  "checking",
  "needs_evidence",
  "accepted",
  "not_supported",
  "withdrawn",
]);
const challenge = z.object({
  id: z.string(),
  claimId: z.string(),
  status,
  currentRevision: z.number(),
  latest: z
    .object({
      revision: z.object({
        explanation: z.string(),
        correctionText: z.string().nullable(),
      }),
    })
    .nullable(),
});
const historyRevision = z.object({
  revision: z.object({
    revision: z.number(),
    status,
    explanation: z.string(),
    correctionText: z.string().nullable(),
  }),
});
const listing = z.object({
  claims: z.array(
    z.object({
      claimId: z.string(),
      claimText: z.string(),
      answerRevision: z.number(),
    }),
  ),
  challenges: z.array(challenge),
});
const labels = {
  submitted: "Received for review",
  checking: "Checking your sources",
  needs_evidence: "More evidence needed",
  accepted: "Updated after review",
  not_supported: "The checked evidence supports the original claim",
  withdrawn: "Withdrawn",
};
export function ClaimChallenge({
  messageId,
  onMessageFeedback,
}: {
  messageId: string;
  onMessageFeedback: () => void;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<z.infer<typeof listing> | null>(null),
    [selected, setSelected] = useState(""),
    [explanation, setExplanation] = useState(""),
    [urls, setUrls] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [reload, setReload] = useState(0),
    [history, setHistory] = useState<z.infer<typeof historyRevision>[] | null>(
      null,
    );
  const fieldId = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    request = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setLoading(true);
    void fetch(
      `/api/claim-challenges?messageId=${encodeURIComponent(messageId)}`,
      { cache: "no-store", signal: c.signal },
    )
      .then(async (r) => {
        if (!r.ok)
          throw Error("This review is unavailable. Your draft is kept.");
        return listing.parse(await r.json());
      })
      .then((value) => {
        if (!c.signal.aborted) {
          setData(value);
          setSelected((previous) =>
            value.claims.some((c) => c.claimId === previous)
              ? previous
              : (value.claims[0]?.claimId ?? ""),
          );
          setError("");
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [messageId, open, reload]);
  async function submit() {
    if (!data) return;
    const claim = data.claims.find((c) => c.claimId === selected);
    if (!claim) return;
    const evidenceUrls = urls
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (evidenceUrls.length > 5) {
      setError("Use up to five source URLs.");
      return;
    }
    const body = {
      messageId,
      answerRevision: claim.answerRevision,
      claimId: claim.claimId,
      explanation,
      evidenceUrls,
    };
    const key = JSON.stringify(body);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const r = await fetch("/api/claim-challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, clientRequestId: request.current.id }),
      });
      if (!r.ok)
        throw Error(
          r.status === 422
            ? "Check the explanation and use valid source URLs."
            : r.status === 409
              ? "This answer changed. Refresh the review before trying again."
              : "We could not save this review. Your draft is kept.",
        );
      await r.json();
      setSaved("Your challenge was saved. Sources still need verification.");
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function withdraw(item: z.infer<typeof challenge>) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        `/api/claim-challenges/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "withdraw",
            expectedRevision: item.currentRevision,
          }),
        },
      );
      if (!r.ok)
        throw Error(
          r.status === 409
            ? "This review changed. Refresh its status and try again."
            : "Withdrawal could not be saved.",
        );
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function readHistory(id: string) {
    setError("");
    try {
      const r = await fetch(`/api/claim-challenges/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!r.ok) throw Error("Review history is unavailable.");
      const value = await r.json();
      setHistory(z.array(historyRevision).parse(value.revisions));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="claim-challenge min-w-0">
      <Button
        ref={trigger}
        type="button"
        variant="link"
        size="sm"
        aria-expanded={open}
        aria-controls={fieldId}
        onClick={() => setOpen((value) => !value)}
      >
        This misses something
      </Button>
      {open && (
        <div
          id={fieldId}
          className="panel space-y-3"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <h4>Review a claim</h4>
          {data?.challenges.some((c) => c.status === "accepted") && (
            <p className="small">
              Updated � The original answer is retained below the review
              history.
            </p>
          )}
          <p className="small muted">
            Bring counterevidence. The original answer stays in history while we
            check it.
          </p>
          {loading && <p role="status">Loading saved claims…</p>}
          {data?.claims.length === 0 && (
            <>
              <p>
                This earlier answer has no saved claim references. You can send
                feedback about the whole message.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={onMessageFeedback}
              >
                Add feedback in chat
              </Button>
            </>
          )}
          {!!data?.claims.length && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="space-y-3"
            >
              <label className="block" htmlFor={`${fieldId}-claim`}>
                Claim
                <select
                  className="block w-full"
                  id={`${fieldId}-claim`}
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {data.claims.map((c) => (
                    <option key={c.claimId} value={c.claimId}>
                      {c.claimText.slice(0, 160)}
                    </option>
                  ))}
                </select>
              </label>
              <blockquote className="break-words">
                {data.claims.find((c) => c.claimId === selected)?.claimText}
              </blockquote>
              <label className="block" htmlFor={`${fieldId}-reason`}>
                What does this miss?
                <textarea
                  className="block w-full"
                  id={`${fieldId}-reason`}
                  required
                  maxLength={4000}
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                />
              </label>
              <label className="block" htmlFor={`${fieldId}-sources`}>
                Source URLs (optional, one per line)
                <textarea
                  className="block w-full"
                  id={`${fieldId}-sources`}
                  value={urls}
                  maxLength={10000}
                  onChange={(e) => setUrls(e.target.value)}
                  aria-describedby={`${fieldId}-help`}
                />
              </label>
              <p id={`${fieldId}-help`} className="small muted">
                Up to five sources. Unsupported or unavailable sources may need
                more evidence.
              </p>
              <Button type="submit" disabled={busy || !explanation.trim()}>
                {busy ? "Saving…" : "Submit for review"}
              </Button>
            </form>
          )}
          {saved && <p role="status">{saved}</p>}
          {!!data?.challenges.length && (
            <div className="space-y-3">
              {data.challenges.map((item) => (
                <article key={item.id} className="space-y-2">
                  <p>
                    <strong>{labels[item.status]}</strong>
                  </p>
                  <p className="break-words">
                    {item.latest?.revision.explanation}
                  </p>
                  {item.latest?.revision.correctionText && (
                    <p className="break-words">
                      Updated: {item.latest.revision.correctionText}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void readHistory(item.id)}
                    >
                      Review history
                    </Button>
                    {["submitted", "checking", "needs_evidence"].includes(
                      item.status,
                    ) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void withdraw(item)}
                      >
                        Withdraw challenge
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {history && (
            <section>
              <h4>Review revisions</h4>
              {history.map((entry, i) => (
                <p className="break-words" key={i}>
                  Revision {entry.revision.revision}:{" "}
                  {labels[entry.revision.status]} � {entry.revision.explanation}
                  {entry.revision.correctionText
                    ? ` Updated: ${entry.revision.correctionText}`
                    : ""}
                </p>
              ))}
            </section>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => setReload((n) => n + 1)}
            >
              Refresh status
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              Close review
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
