"use client";
import { useState } from "react";
import { MessageCircle, PanelRightClose, Send } from "lucide-react";
import { Button } from "./ui/button";
import { marketKey, type Market } from "../lib/catalog";
import { usePreview } from "./shell-store";
import { knownThreadIds } from "../lib/preview-state";
export function ChatPanel({
  m,
  visible,
  onClose,
  onMarket,
}: {
  m: Market;
  visible: boolean;
  onClose: () => void;
  onMarket: () => void;
}) {
  const { state, update, ready } = usePreview();
  const key = marketKey(m);
  const pick = state.picks[key];
  const [sendError, setSendError] = useState("");
  const thread = state.current[key] ?? 1;
  const chatKey = `${key}:thread-${thread}`;
  const draft = state.drafts[chatKey] ?? "";
  const messages = state.threads[chatKey] ?? [];
  const threadIds = knownThreadIds(state, key);
  const setDraft = (text: string) =>
    update((s) => ({ ...s, drafts: { ...s.drafts, [chatKey]: text } }));
  const send = () => {
    if (!draft.trim()) return;
    update((s) => ({
      ...s,
      threads: {
        ...s.threads,
        [chatKey]:
          s.threads[chatKey]?.at(-1) === draft.trim()
            ? s.threads[chatKey]!
            : [...(s.threads[chatKey] ?? []), draft.trim()],
      },
    }));
    setSendError(
      "Thesis is not connected yet. Your message and draft are kept in this browser.",
    );
  };
  return (
    <aside
      aria-label="Thesis contextual chat"
      className={`chat-pane ${!visible ? "mobile-hidden" : ""}`}
    >
      <div className="row">
        <div>
          <h2>≋ Thesis</h2>
          <p className="muted small">Your thinking partner</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Collapse chat"
          onClick={() => {
            onClose();
          }}
        >
          <PanelRightClose />
        </Button>
      </div>
      <div className="context">
        <strong>{m.question}</strong>
        <p>
          {m.platform} · Your saved pick: {pick?.outcome ?? "Not selected"}
        </p>
        <a href="#main" onClick={() => onMarket()}>
          Inspect market and rules
        </a>
      </div>
      <div className="row">
        <label className="small">
          Conversation{" "}
          <select
            aria-label="Conversation in this market"
            value={thread}
            onChange={(e) => {
              setSendError("");
              update((s) => ({
                ...s,
                current: { ...s.current, [key]: Number(e.target.value) },
              }));
            }}
          >
            {threadIds.map((id) => (
              <option key={id} value={id}>
                Chat {id}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="link"
          disabled={threadIds.length >= 1000}
          onClick={() => {
            setSendError("");
            update((s) => {
              const next = knownThreadIds(s, key).length + 1;
              return {
                ...s,
                drafts: { ...s.drafts, [`${key}:thread-${next}`]: "" },
                current: { ...s.current, [key]: next },
              };
            });
          }}
        >
          New chat
        </Button>
      </div>
      <div className="messages" aria-label="Locally saved messages">
        {!messages.length && (
          <div className="chat-empty">
            <MessageCircle size={30} />
            <h3>Make room for a second thought.</h3>
            <p>
              Ask about the exact market, challenge your reason, or bring a
              source.
            </p>
            <p className="small">
              Thesis is not connected yet. Keep your thoughts here while the
              connection is being set up.
            </p>
          </div>
        )}
        {messages.map((text, i) => (
          <div className="bubble" key={i}>
            <span className="small muted">You · saved locally</span>
            <p>{text}</p>
          </div>
        ))}
      </div>
      <div className="composer">
        <div className="starters">
          {["Challenge my view", "Check a source", "What changed?"].map((t) => (
            <Button
              variant="outline"
              size="sm"
              key={t}
              onClick={() => setDraft(t)}
            >
              {t}
            </Button>
          ))}
        </div>
        <label htmlFor="chat-draft">Message Thesis</label>
        <textarea
          id="chat-draft"
          value={draft}
          onChange={(e) => {
            setSendError("");
            setDraft(e.target.value);
          }}
          placeholder="Ask, disagree, or add a link…"
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="row">
          <span className="small muted">
            Enter sends · Shift+Enter for a new line
          </span>
          <Button disabled={!ready || !draft.trim()} onClick={send}>
            <Send size={16} />
            Send
          </Button>
        </div>
        {sendError && (
          <p role="status" className="connection">
            {sendError}
          </p>
        )}
        <p className="small muted">Thesis is not connected yet</p>
      </div>
    </aside>
  );
}
