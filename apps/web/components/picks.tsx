"use client";
import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "./ui/button";
import { markets, marketKey } from "../lib/catalog";
import { usePreview } from "./shell-store";
import { AccountPicks } from "./account-picks";
import { Card } from "./market-card";
export function SamplePicks() {
  const { state, ready, update } = usePreview();
  const [tab, setTab] = useState("Following");
  const items = markets.filter((m) =>
    tab === "Saved"
      ? state.saved.includes(marketKey(m))
      : !!state.picks[marketKey(m)],
  );
  return (
    <section className="page">
      <div className="row">
        <div>
          <h2>Sample scenarios</h2>
          <p className="lead">Your view, and the reason behind it.</p>
        </div>
        <Button asChild>
          <Link href="/">
            Add a pick <Plus size={16} />
          </Link>
        </Button>
      </div>
      <div className="filters">
        {["Following", "Saved"].map((t) => (
          <Button
            key={t}
            variant={tab === t ? "secondary" : "ghost"}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t} ·{" "}
            {t === "Saved"
              ? state.saved.length
              : Object.keys(state.picks).length}
          </Button>
        ))}
      </div>
      {!ready ? (
        <p role="status">Restoring your local preview…</p>
      ) : items.length ? (
        <div className="grid">
          {items.map((m) => {
            const p = state.picks[marketKey(m)];
            return (
              <div key={marketKey(m)}>
                <Card m={m} />
                {tab === "Following" && p && (
                  <div className="pick-tail">
                    <strong>
                      Your pick: {p.outcome} · v{p.version}
                    </strong>
                    <p>{p.reason || "No reason recorded."}</p>
                    <p className="small">
                      {p.paused
                        ? "Paused locally"
                        : "Waiting for live updates to be connected"}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        update((s) => ({
                          ...s,
                          picks: {
                            ...s.picks,
                            [marketKey(m)]: { ...p, paused: !p.paused },
                          },
                        }))
                      }
                    >
                      {p.paused ? "Resume preview" : "Pause updates"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <h2>
            {tab === "Saved"
              ? "A place for your next idea"
              : "Start with one considered pick"}
          </h2>
          <p>
            {tab === "Saved"
              ? "Bookmark a market to return later. Saving does not create a pick."
              : "Choose a market and record your own outcome. Everything stays in this browser."}
          </p>
          <Button asChild>
            <Link href="/">Discover markets</Link>
          </Button>
        </div>
      )}
    </section>
  );
}

export function Picks() {
  const [sample, setSample] = useState(false);
  return (
    <>
      <AccountPicks />
      <div className="page">
        <Button
          variant="outline"
          aria-expanded={sample}
          onClick={() => setSample(!sample)}
        >
          {sample ? "Hide" : "Show"} sample scenarios
        </Button>
        <p className="small muted">
          Fictional scenarios use separate browser preview data.
        </p>
      </div>
      {sample && <SamplePicks />}
    </>
  );
}
