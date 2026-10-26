"use client";
import { useRef, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { lessonReceipt } from "../../../packages/domain/src/lesson-review";
export function LessonReview({
  domain = "Sports",
  competition,
  sourceRunId,
  onSaved,
  existing,
  initialRule,
}: {
  domain?: string;
  competition?: string;
  sourceRunId?: string;
  onSaved?: () => void;
  existing?: { id: string; version: number; rule: string };
  initialRule?: string;
}) {
  const [rule, setRule] = useState(existing?.rule ?? initialRule ?? ""),
    [category, setCategory] = useState(domain),
    [league, setLeague] = useState(competition ?? "");
  const [consent, setConsent] = useState(false),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const receipt = useRef<{ fingerprint: string; requestId: string } | null>(
    null,
  );
  async function save() {
    if (busy || !review || !consent) return;
    setBusy(true);
    setNotice("");
    const payload = {
      rule: rule.trim(),
      scope: {
        domain: category.trim(),
        ...(league.trim() ? { competition: league.trim() } : {}),
      },
      confirmed: true,
      memoryConsent: true,
      ...(existing
        ? { action: "edit", baseVersion: existing.version }
        : sourceRunId
          ? { sourceRunId }
          : {}),
    };
    try {
      const account = await fetch("/api/agent/status", { cache: "no-store" });
      const status = await account.json();
      if (
        !account.ok ||
        !status.authenticated ||
        typeof status.userId !== "string"
      )
        throw new Error("Sign in before saving a preference.");
      const ownedKey = `thesisbreak.lesson.receipt.${existing?.id ?? sourceRunId ?? "manual"}.${status.userId}`;
      try {
        const old = z
          .object({ fingerprint: z.string(), requestId: z.uuid() })
          .safeParse(JSON.parse(sessionStorage.getItem(ownedKey) ?? "null"));
        if (old.success) receipt.current = old.data;
      } catch {}
      receipt.current = lessonReceipt(receipt.current, payload, () =>
        crypto.randomUUID(),
      );
      try {
        sessionStorage.setItem(ownedKey, JSON.stringify(receipt.current));
      } catch {}
      const response = await fetch(
        existing
          ? `/api/lessons/${encodeURIComponent(existing.id)}`
          : "/api/lessons",
        {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            requestId: receipt.current.requestId,
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "This request changed. Reopen the review before trying again."
            : "Could not save your preference. Your text is kept.",
        );
      z.object({ lessonId: z.string(), version: z.number() }).parse(
        await response.json(),
      );
      try {
        sessionStorage.removeItem(ownedKey);
      } catch {}
      receipt.current = null;
      setRule("");
      setReview(false);
      setConsent(false);
      setNotice(
        "Preference approved. Walrus storage is queued; it is not verified yet.",
      );
      onSaved?.();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Saving is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="lesson-review panel">
      <h3>What should Thesis do differently next time?</h3>
      <p className="small muted">
        Write a preference for future events. Chat messages are never approved
        automatically.
      </p>
      <label>
        Preference
        <textarea
          value={rule}
          maxLength={2000}
          disabled={busy || review}
          onChange={(e) => setRule(e.target.value)}
          placeholder="Wait for the official lineup before challenging my pick."
        />
      </label>
      <div className="lesson-scope">
        <label>
          Use for category
          <input
            value={category}
            maxLength={128}
            disabled={busy || review}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
        <label>
          Competition (optional)
          <input
            value={league}
            maxLength={128}
            disabled={busy || review}
            onChange={(e) => setLeague(e.target.value)}
          />
        </label>
      </div>
      {review ? (
        <>
          <p>
            <strong>Review:</strong> “{rule.trim()}” · {category.trim()}
            {league.trim() ? ` / ${league.trim()}` : " / any competition"}
          </p>
          <label className="lesson-consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            Store this preference in my account and Walrus Memory. Stopping its
            use later does not erase an existing Walrus blob.
          </label>
          <div className="row">
            <Button disabled={busy || !consent} onClick={() => void save()}>
              {busy ? "Saving…" : "Approve and remember"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReview(false);
                setConsent(false);
              }}
            >
              Edit / just this once
            </Button>
          </div>
        </>
      ) : (
        <Button
          disabled={busy || !rule.trim() || !category.trim()}
          onClick={() => setReview(true)}
        >
          Review preference
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
