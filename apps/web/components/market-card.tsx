"use client";
import Link from "next/link";
import { Bookmark, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
import { marketKey, marketPath, type Market } from "../lib/catalog";
import { usePreview } from "./shell-store";
export function ToggleSave({ m }: { m: Market }) {
  const { state, update, ready } = usePreview();
  const key = marketKey(m);
  const saved = state.saved.includes(key);
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={!ready}
      aria-label={`${saved ? "Unsave" : "Save"} ${m.question}`}
      aria-pressed={saved}
      onClick={() =>
        update((s) => ({
          ...s,
          saved: saved ? s.saved.filter((x) => x !== key) : [...s.saved, key],
        }))
      }
    >
      <Bookmark fill={saved ? "currentColor" : "none"} />
    </Button>
  );
}
export function Card({ m }: { m: Market }) {
  return (
    <article className="market-card">
      <div className="row">
        <span className="muted">◈ {m.platform}</span>
        <ToggleSave m={m} />
      </div>
      <div className="fixture">
        <span className="crest">{m.teams[0][0]}</span>
        <span className="crest away">{m.teams[1][0]}</span>
        <h3>
          <Link href={marketPath(m)}>{m.question}</Link>
        </h3>
      </div>
      <p className="muted small">{m.time}</p>
      <div className="odds">
        <span>Yes {m.yes}%</span>
        <span>No {100 - m.yes}%</span>
      </div>
      <p className="small muted">Illustrative market chance</p>
      <Link className="text-link" href={marketPath(m)}>
        View market <ArrowRight size={16} />
      </Link>
    </article>
  );
}
