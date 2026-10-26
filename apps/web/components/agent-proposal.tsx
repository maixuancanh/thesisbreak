"use client";
import { useRef, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import type { ResearchResult } from "../lib/agent-client";
const proposalSchema = z.object({
  proposalId: z.string(),
  before: z.object({ outcome: z.string(), reason: z.string() }),
  after: z.object({ outcome: z.string(), reason: z.string() }),
  expiresAt: z.string(),
});
export function AgentProposal({ result }: { result: ResearchResult }) {
  const [review, setReview] = useState<z.infer<typeof proposalSchema> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const ids = useRef({ propose: "", confirm: "" });
  const change = result.reply.proposedChange;
  const pick = result.pick;
  if (!change || !pick) return null;
  async function act(confirm: boolean) {
    if (!change || !pick || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!ids.current.propose)
        ids.current = {
          propose: crypto.randomUUID(),
          confirm: crypto.randomUUID(),
        };
      const response = await fetch(
        `/api/picks/${encodeURIComponent(pick.id)}/${confirm ? "confirm" : "proposals"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            confirm
              ? {
                  requestId: ids.current.confirm,
                  proposalId: review!.proposalId,
                  confirmed: true,
                }
              : {
                  requestId: ids.current.propose,
                  baseVersion: change.baseVersion,
                  changes: {
                    ...(change.outcome !== null
                      ? { outcome: change.outcome }
                      : {}),
                    ...(change.reason !== null
                      ? { reason: change.reason }
                      : {}),
                  },
                  reason: "User requested review of Thesis suggestion",
                },
          ),
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "Your pick changed. Ask Thesis to review the latest version."
            : "Could not update this pick. Your saved pick is unchanged.",
        );
      const body = await response.json();
      if (confirm) {
        z.object({
          pickId: z.string(),
          version: z.number().int().positive(),
        }).parse(body);
        setSaved(true);
      } else setReview(proposalSchema.parse(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Change unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-suggestion">
      <h3>{saved ? "Pick updated" : "Suggested change"}</h3>
      {saved ? (
        <p>Your confirmed change was saved.</p>
      ) : review ? (
        <>
          <p>
            Before: {review.before.outcome} —{" "}
            {review.before.reason || "No reason"}
          </p>
          <p>
            After: {review.after.outcome} — {review.after.reason || "No reason"}
          </p>
          <Button
            disabled={busy || Date.parse(review.expiresAt) <= Date.now()}
            onClick={() => void act(true)}
          >
            Confirm change
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Keep my pick
          </Button>
        </>
      ) : (
        <>
          <p>
            {change.outcome ?? pick.outcome} — {change.reason ?? pick.reason}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(false)}
          >
            Review suggested change
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
