"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { LivePickForm } from "./live-pick-form";
import type { LiveMarket, LiveProvider } from "../lib/live-market";
export function AgentPickDraft({
  draft,
  market,
  provider,
}: {
  draft: { outcome: string; reason: string };
  market: LiveMarket;
  provider: LiveProvider;
}) {
  const [review, setReview] = useState(false);
  if (!market.outcomes.some((o) => o.name === draft.outcome)) return null;
  return (
    <section className="agent-suggestion">
      <h3>Suggested pick</h3>
      <p>
        {draft.outcome} — {draft.reason || "Add your reason before saving."}
      </p>
      <Button
        variant="outline"
        aria-expanded={review}
        onClick={() => setReview((x) => !x)}
      >
        {review ? "Close review" : "Review suggested pick"}
      </Button>
      {review && (
        <LivePickForm
          market={market}
          provider={provider}
          initialOutcome={draft.outcome}
          initialReason={draft.reason}
          compact
        />
      )}
    </section>
  );
}
