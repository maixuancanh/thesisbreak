"use client";
import { useState } from "react";
export function SourceFactReview({
  profileId,
  onSaved,
}: {
  profileId: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  return (
    <details>
      <summary>Review a factual claim</summary>
      <p className="small">
        Compare what this source said with a reference you trust. This is your
        review, kept separate from prediction results.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const form = e.currentTarget,
            data = new FormData(form);
          setBusy(true);
          setNotice("");
          try {
            const r = await fetch("/api/sources/reviews", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                profileId,
                requestId: crypto.randomUUID(),
                claim: data.get("claim"),
                sourceReference: data.get("source"),
                evidenceReference: data.get("evidence"),
                verdict: data.get("verdict"),
                scope: {
                  league: data.get("league"),
                  market: "winner",
                  horizon: "pregame",
                },
                confirmed: true,
              }),
            });
            if (!r.ok)
              throw Error("Could not save your review. Please try again.");
            form.reset();
            setNotice("Review saved. Your source memory will update.");
            onSaved();
          } catch (err) {
            setNotice(
              err instanceof Error ? err.message : "Could not save review.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          League
          <input name="league" defaultValue="NBA" required maxLength={80} />
        </label>
        <label>
          What did the source say?
          <textarea name="claim" required maxLength={2000} />
        </label>
        <label>
          Original claim link
          <input name="source" type="url" placeholder="https://…" required />
        </label>
        <label>
          Reference you checked
          <input name="evidence" type="url" placeholder="https://…" required />
        </label>
        <label>
          Your assessment
          <select name="verdict">
            <option value="supported">Supported by the reference</option>
            <option value="refuted">Contradicted by the reference</option>
            <option value="unclear">Still unclear</option>
          </select>
        </label>
        <p className="small">
          Saving adds this review to the source memory you already chose to
          store. It is labelled as reviewed by you, not independently verified.
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save my review"}
        </button>
        <p role="status">{notice}</p>
      </form>
    </details>
  );
}
