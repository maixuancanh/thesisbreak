"use client";
import { useRef, useState } from "react";
import { Button } from "./ui/button";
export function WatchPick({
  pickId,
  version,
}: {
  pickId: string;
  version: number;
}) {
  const [review, setReview] = useState(false),
    [hours, setHours] = useState("24"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const receipt = useRef<{ key: string; id: string } | null>(null);
  const [independentNews, setIndependentNews] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const key = JSON.stringify([pickId, version, hours, independentNews]);
    if (receipt.current?.key !== key)
      receipt.current = { key, id: crypto.randomUUID() };
    try {
      const r = await fetch("/api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pickId,
          baseVersion: version,
          durationHours: Number(hours),
          requestId: receipt.current.id,
          confirmed: true,
          independentNews,
        }),
      });
      if (!r.ok)
        throw new Error(
          r.status === 409
            ? "Pick changed or watch limit reached. Refresh before trying again."
            : "Could not start watching.",
        );
      receipt.current = null;
      setNotice("Watch saved. Updates appear in This week.");
      setReview(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Watch unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="agent-suggestion">
      {review ? (
        <>
          <p>
            Watch this saved version's market price, settlement rules and final
            Kalshi result. No automatic pick changes. Enable official
            player-status alerts below for mapped NBA games.
          </p>
          <label>
            Watch for
            <select
              disabled={busy}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            >
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={independentNews}
              disabled={busy}
              onChange={(e) => setIndependentNews(e.target.checked)}
            />{" "}
            Include official NBA player-status changes related to my saved
            reason
          </label>
          <Button disabled={busy} onClick={() => void save()}>
            Confirm watch
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setReview(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="outline" onClick={() => setReview(true)}>
          Watch this market
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
