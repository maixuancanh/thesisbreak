"use client";
import { useEffect, useRef, useState } from "react";
import type { RunState } from "../../../packages/db/src/agent-run-control";
export type { RunState };
export function RunProgress({
  runId,
  onResult,
}: {
  runId: string;
  onResult: (state: RunState) => void;
}) {
  const [message, setMessage] = useState(
    "Research is running. Waiting for saved status…",
  );
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [retry, setRetry] = useState(0);
  const callback = useRef(onResult);
  callback.current = onResult;
  const terminal = useRef(false);
  const cancelId = useRef<string | null>(null);
  const source = useRef<EventSource | null>(null);
  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    terminal.current = false;
    cancelId.current = null;
    const connect = () => {
      if (disposed || terminal.current) return;
      const events = new EventSource(
        `/api/agent/runs/${encodeURIComponent(runId)}/stream`,
      );
      source.current = events;
      events.addEventListener("status", (event) => {
        try {
          const state = JSON.parse((event as MessageEvent).data) as RunState;
          if (
            state.runId !== runId ||
            !["running", "completed", "failed"].includes(state.status)
          )
            return;
          if (state.status !== "running") {
            terminal.current = true;
            events.close();
            setMessage(
              state.status === "completed"
                ? "Research complete."
                : (state.result as { error?: string } | null)?.error ===
                    "CANCELLED"
                  ? "Research cancelled."
                  : "Research failed.",
            );
            callback.current(state);
          } else setMessage("Research is running. Waiting for saved status…");
        } catch {
          setMessage("Could not read run status.");
          events.close();
        }
      });
      const disconnected = () => {
        events.close();
        if (disposed || terminal.current) return;
        if (++attempts <= 12) {
          setMessage("Reconnecting to saved run status…");
          timer = setTimeout(connect, Math.min(5000, 500 * attempts));
        } else
          setMessage("Status connection paused. Reconnect to check this run.");
      };
      events.onerror = disconnected;
      events.addEventListener("unavailable", disconnected);
    };
    connect();
    return () => {
      disposed = true;
      source.current?.close();
      if (timer) clearTimeout(timer);
    };
  }, [runId, retry]);
  async function cancel() {
    setCancelling(true);
    cancelId.current ??= crypto.randomUUID();
    try {
      const response = await fetch(
        `/api/agent/runs/${encodeURIComponent(runId)}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmed: true,
            requestId: cancelId.current,
            expectedRevision: 1,
          }),
        },
      );
      if (!response.ok) throw new Error();
      const state = (await response.json()) as RunState;
      terminal.current = true;
      source.current?.close();
      setMessage("Research cancelled.");
      callback.current(state);
    } catch {
      setMessage(
        "Cancellation could not be confirmed. Check saved status before retrying.",
      );
    } finally {
      setCancelling(false);
      setConfirming(false);
    }
  }
  return (
    <div aria-label="Research progress">
      <p role="status" aria-live="polite">
        {message}
      </p>
      {!terminal.current && (
        <>
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            Reconnect status
          </button>
          {confirming ? (
            <>
              <p>Cancel this research run?</p>
              <button
                type="button"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? "Cancelling…" : "Confirm cancellation"}
              </button>
              <button
                type="button"
                disabled={cancelling}
                onClick={() => setConfirming(false)}
              >
                Keep running
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              Cancel research
            </button>
          )}
        </>
      )}
    </div>
  );
}
