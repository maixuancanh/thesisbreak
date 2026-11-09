"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import type { ReviewFollowup } from "../lib/review-case-client";
export function ReviewFollowupControls({
  followup,
  onSaved,
}: {
  followup: ReviewFollowup;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  async function change(action: "acknowledge" | "snooze" | "stop") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/review-followups/${encodeURIComponent(followup.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            caseRevision: followup.caseRevision,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(action === "snooze"
              ? { dueAt: new Date(Date.now() + 3600000).toISOString() }
              : {}),
          }),
        },
      );
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "This review changed. Refresh before changing the reminder."
            : "The reminder could not be changed. Try again.",
        );
      setSaved(
        action === "stop"
          ? "Future reminders for this pick are stopped."
          : action === "snooze"
            ? "This reminder is snoozed for one hour."
            : "This reminder is marked handled. Monitoring stays active.",
      );
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    onSaved();
  }
  return (
    <div aria-busy={busy}>
      {saved ? (
        <p className="small" role="status">
          {saved}
        </p>
      ) : (
        <div className="row flex-wrap">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void change("acknowledge")}
          >
            Mark reminder handled
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void change("snooze")}
          >
            Remind me in an hour
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void change("stop")}
          >
            Stop reminders for this pick
          </Button>
        </div>
      )}
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
