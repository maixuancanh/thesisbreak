"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./ui/dialog";
import { marketKey, type Market } from "../lib/catalog";
import { usePreview } from "./shell-store";
import { ToggleSave } from "./market-card";
import { ChatPanel } from "./chat-panel";
import { type Draft, pickDraft, savePreviewPick } from "../lib/preview-state";
export function MarketDetail({ m }: { m: Market }) {
  return <Detail m={m} />;
}
function Detail({ m }: { m: Market }) {
  const { state, update, ready } = usePreview();
  const router = useRouter();
  const key = marketKey(m);
  const pick = state.picks[key];
  const form = pickDraft(state, key);
  const [review, setReview] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [mobile, setMobile] = useState("Market");
  const edit = (field: keyof Draft, value: string) =>
    update((s) => ({
      ...s,
      forms: { ...s.forms, [key]: { ...form, [field]: value } },
    }));
  const save = () => {
    const outcome = form.outcome;
    if (!outcome) return;
    const at = new Date().toISOString();
    update((s) => savePreviewPick(s, key, at));
    setReview(false);
    router.push("/picks");
  };
  return (
    <main id="main" className={`detail ${chatOpen ? "" : "collapsed"}`}>
      <div className="mobile-switch">
        {["Market", "Chat"].map((t) => (
          <Button
            key={t}
            aria-pressed={mobile === t}
            variant={mobile === t ? "secondary" : "outline"}
            onClick={() => {
              setMobile(t);
              if (t === "Chat") setChatOpen(true);
            }}
          >
            {t}
          </Button>
        ))}
      </div>
      <section
        className={`market-pane ${mobile !== "Market" ? "mobile-hidden" : ""}`}
      >
        <Link href="/picks" className="text-link">
          ← My picks
        </Link>
        <div className="filters">
          <span className="pill">{m.platform}</span>
          <span className="pill green">{m.category}</span>
          <ToggleSave m={m} />
        </div>
        <p>
          <span className="pill">Sample scenario</span> · Fictional event ·{" "}
          <Link className="text-link" href="/">
            Browse live markets
          </Link>
        </p>
        <div className="teams">
          <span className="crest">{m.teams[0][0]}</span>
          <h1>
            {m.teams[0]} <span className="muted">vs</span> {m.teams[1]}
          </h1>
          <span className="crest away">{m.teams[1][0]}</span>
        </div>
        <p className="muted">{m.time} · Fictional event</p>
        <section className="panel">
          <h2>{m.question}</h2>
          <div className="odds">
            <span>Yes {m.yes}%</span>
            <span>No {100 - m.yes}%</span>
          </div>
          <p className="small muted">
            Illustrative market chance, not an agent forecast
          </p>
          <details>
            <summary>What counts as a win? · Full sample rules</summary>
            <p>{m.rules}</p>
          </details>
        </section>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            setReview(true);
          }}
        >
          <h2>Your pick</h2>
          <fieldset>
            <legend>
              Choose your outcome{" "}
              <span className="muted small">(required)</span>
            </legend>
            <div className="outcomes">
              {["Yes", "No"].map((o) => (
                <label key={o} className={form.outcome === o ? "selected" : ""}>
                  <input
                    required
                    type="radio"
                    name="outcome"
                    value={o}
                    checked={form.outcome === o}
                    onChange={() => edit("outcome", o)}
                  />
                  {o}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="reason">
            Why do you think so? <span className="muted small">Optional</span>
          </label>
          <textarea
            id="reason"
            value={form.reason}
            onChange={(e) => edit("reason", e.target.value)}
            placeholder="The assumption behind your pick…"
          />
          <label htmlFor="source">
            I’ll keep an eye on{" "}
            <span className="muted small">Preview plan</span>
          </label>
          <select
            id="source"
            value={form.source}
            onChange={(e) => edit("source", e.target.value)}
          >
            <option>Official team news (sample preference)</option>
            <option>Fixture result (sample preference)</option>
            <option>No monitoring requested</option>
          </select>
          <label htmlFor="condition">
            What would change your mind?{" "}
            <span className="muted small">Optional</span>
          </label>
          <textarea
            id="condition"
            value={form.condition}
            onChange={(e) => edit("condition", e.target.value)}
            placeholder="An update worth reviewing…"
          />
          <p className="small muted">
            No news is being fetched. Saving records a local plan with
            monitoring pending.
          </p>
          <Button type="submit" disabled={!ready}>
            Review {pick ? "changes" : "my pick"} <ArrowRight size={16} />
          </Button>
        </form>
        {pick && (
          <div className="panel">
            <h2>Saved version {pick.version}</h2>
            <p>
              {pick.outcome} · {pick.reason || "No reason recorded"}
            </p>
            <Button
              variant="outline"
              onClick={() =>
                update((s) => ({
                  ...s,
                  picks: {
                    ...s.picks,
                    [key]: { ...pick, paused: !pick.paused },
                  },
                }))
              }
            >
              {pick.paused ? "Resume local plan" : "Pause updates"}
            </Button>
            <p className="small muted">
              {pick.paused
                ? "Paused locally"
                : "Waiting for live updates to be connected"}
            </p>
          </div>
        )}
        {!chatOpen && (
          <Button
            variant="outline"
            onClick={() => {
              setChatOpen(true);
              setMobile("Chat");
            }}
          >
            <MessageCircle size={16} />
            Open Thesis chat
          </Button>
        )}
      </section>
      {chatOpen && (
        <ChatPanel
          m={m}
          visible={mobile === "Chat"}
          onClose={() => {
            setChatOpen(false);
            setMobile("Market");
          }}
          onMarket={() => setMobile("Market")}
        />
      )}
      <Dialog open={review} onOpenChange={setReview}>
        <DialogContent>
          <DialogTitle>Review your {pick ? "changes" : "new pick"}</DialogTitle>
          <DialogDescription>
            Review your changes before saving. Saved in this browser for this
            preview.
          </DialogDescription>
          <div className="comparison">
            {["outcome", "reason", "source", "condition"].map((field) => (
              <div key={field}>
                <strong>{field}</strong>
                <p>
                  <span className="muted">Before: </span>
                  {pick?.[field as keyof Draft] || "Not recorded"}
                </p>
                <p>
                  <span className="muted">After: </span>
                  {form[field as keyof Draft] || "Not recorded"}
                </p>
              </div>
            ))}
          </div>
          <div className="row">
            <DialogClose asChild>
              <Button variant="outline">Keep editing</Button>
            </DialogClose>
            <Button disabled={!form.outcome} onClick={save}>
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
