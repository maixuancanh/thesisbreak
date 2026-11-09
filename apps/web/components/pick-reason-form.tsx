"use client";
import { usePickReviewEnabled } from "./pick-review-feature";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { reasonConditionSchema } from "../../../packages/domain/src/pick-reason";
import { Button } from "./ui/button";
const response = z.object({
  basePickVersion: z.number().optional(),
  availableConditions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        condition: reasonConditionSchema,
      }),
    )
    .default([]),
  reason: z
    .object({
      userText: z.string(),
      pickVersion: z.number(),
      revision: z.number(),
      conditions: z.array(z.object({ revisitWhen: z.string() })),
    })
    .nullable(),
  monitoring: z.object({
    enabled: z.boolean(),
    bindingCount: z.number(),
    unsupportedConditions: z.array(z.string()),
  }),
});
function PickReasonFormEnabled({
  pickId,
  version,
  initialReason = "",
}: {
  pickId: string;
  version: number;
  initialReason?: string;
}) {
  const id = useId();
  const [reason, setReason] = useState(initialReason),
    [revisit, setRevisit] = useState(""),
    [source, setSource] = useState(""),
    [enableMonitoring, setEnableMonitoring] = useState(false),
    [data, setData] = useState<z.infer<typeof response> | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [stale, setStale] = useState(false),
    [reload, setReload] = useState(0);
  const request = useRef<{ body: string; id: string } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    void fetch(`/api/picks/${encodeURIComponent(pickId)}/reason`, {
      cache: "no-store",
      signal: c.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            r.status === 404
              ? "Reason monitoring is not available yet."
              : "Your saved reason could not be loaded.",
          );
        return response.parse(await r.json());
      })
      .then((value) => {
        if (c.signal.aborted) return;
        setData(value);
        if (!stale) {
          setReason(value.reason?.userText ?? initialReason);
          setRevisit(value.reason?.conditions[0]?.revisitWhen ?? "");
          setEnableMonitoring(value.monitoring.enabled);
          setSource(
            value.availableConditions.find((c) =>
              value.reason?.conditions.some(
                (old) => old.revisitWhen === c.condition.revisitWhen,
              ),
            )?.id ?? "",
          );
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof z.ZodError
              ? "Your saved reason could not be read. Refresh before confirming."
              : (e as Error).message,
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [pickId, reload]);
  async function save() {
    if (busy || !review) return;
    setBusy(true);
    setError("");
    setMessage("");
    const payload = {
      basePickVersion:
        data?.basePickVersion ?? data?.reason?.pickVersion ?? version,
      reason: reason.trim(),
      conditions:
        source && data?.availableConditions.some((c) => c.id === source)
          ? [data.availableConditions.find((c) => c.id === source)!.condition]
          : revisit.trim()
            ? [
                {
                  kind: "manual_review",
                  statement: reason.trim().slice(0, 1000),
                  revisitWhen: revisit.trim(),
                  predicate: { type: "manual" },
                  sourcePolicy: "manual",
                },
              ]
            : [],
      confirmed: true,
      enableMonitoring: !!source && enableMonitoring,
    };
    const body = JSON.stringify(payload);
    if (request.current?.body !== body)
      request.current = { body, id: crypto.randomUUID() };
    try {
      const r = await fetch(`/api/picks/${encodeURIComponent(pickId)}/reason`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: request.current.id }),
      });
      if (!r.ok) {
        if (r.status === 409) {
          setStale(true);
          setReview(false);
          setReload((x) => x + 1);
        }
        throw Error(
          r.status === 409
            ? "Your pick changed. Compare the latest saved reason below with your draft, then review again."
            : r.status === 401
              ? "Sign in again to confirm your reason."
              : "Your reason could not be saved. Your draft is kept.",
        );
      }
      const value = response.parse(await r.json());
      setData((previous) => ({
        ...value,
        basePickVersion:
          value.basePickVersion ?? previous?.basePickVersion ?? version,
        availableConditions: value.availableConditions.length
          ? value.availableConditions
          : (previous?.availableConditions ?? []),
      }));
      setReview(false);
      setStale(false);
      setMessage(
        value.monitoring.enabled
          ? "Reason confirmed and saved. Source monitoring is enabled."
          : "Reason confirmed and saved. Automatic source monitoring is not configured.",
      );
    } catch (e) {
      setError(
        e instanceof z.ZodError
          ? "Your saved reason could not be read. Refresh before confirming."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pick-reason-form">
      <h3>Why / Revisit if</h3>
      {loading ? (
        <p role="status">Loading your confirmed reason…</p>
      ) : (
        <>
          <p className="small muted">
            {data?.monitoring.enabled
              ? `${data.monitoring.bindingCount} source bindings enabled.`
              : "Add a reason to watch for changes. Automatic monitoring is not configured."}
          </p>
          {!!data?.monitoring.unsupportedConditions.length && (
            <ul className="small muted">
              {data.monitoring.unsupportedConditions.map((condition, i) => (
                <li key={i}>{condition}</li>
              ))}
            </ul>
          )}
          <label htmlFor={`${id}-why`}>Why do you think so?</label>
          <textarea
            id={`${id}-why`}
            aria-describedby={error ? `${id}-error` : undefined}
            maxLength={4000}
            value={reason}
            disabled={busy}
            onChange={(e) => {
              setReason(e.target.value);
              setReview(false);
              setMessage("");
            }}
          />
          {!data?.availableConditions.length && (
            <p className="small muted">
              Set up an approved report watch from the market page to enable
              source monitoring.
            </p>
          )}
          <label htmlFor={`${id}-source`}>Watch for changes</label>
          <select
            id={`${id}-source`}
            value={source}
            disabled={busy}
            onChange={(e) => {
              setSource(e.target.value);
              setReview(false);
              setEnableMonitoring(!!e.target.value);
            }}
          >
            <option value="">My own review condition</option>
            {data?.availableConditions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {source && (
            <label className="row">
              <input
                type="checkbox"
                checked={enableMonitoring}
                disabled={busy}
                onChange={(e) => {
                  setEnableMonitoring(e.target.checked);
                  setReview(false);
                }}
              />{" "}
              Monitor this report for this pick
            </label>
          )}
          <label htmlFor={`${id}-revisit`}>Revisit if</label>
          <textarea
            id={`${id}-revisit`}
            maxLength={1000}
            value={
              source
                ? (data?.availableConditions.find((c) => c.id === source)
                    ?.condition.revisitWhen ?? revisit)
                : revisit
            }
            disabled={busy || !!source}
            placeholder="What would make you reconsider?"
            onChange={(e) => {
              setRevisit(e.target.value);
              setReview(false);
              setMessage("");
            }}
          />
          <p className="small muted">
            {source
              ? data?.availableConditions.find((c) => c.id === source)
                  ?.condition.kind === "official_lineup"
                ? "Only an official lineup update can establish whether this condition occurred."
                : "Only a verified correction or withdrawal can trigger this report condition."
              : "A personal review condition. No source will be fetched automatically for this condition."}
          </p>
          {stale && (
            <div className="context">
              <h4>Latest saved reason</h4>
              <p>{data?.reason?.userText ?? "No confirmed reason"}</p>
              <h4>Your draft</h4>
              <p>{reason}</p>
            </div>
          )}
          {review ? (
            <div className="context">
              <h4>Confirm your reason</h4>
              <p>{reason}</p>
              <p>
                Revisit if:{" "}
                {source
                  ? data?.availableConditions.find((c) => c.id === source)
                      ?.condition.revisitWhen
                  : revisit || "No condition added"}
              </p>
              <p>
                {source && enableMonitoring
                  ? "Enable source monitoring for this pick."
                  : "Save reason only."}
              </p>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Confirm reason"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                Keep editing
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              disabled={!reason.trim() || busy || !data}
              onClick={() => setReview(true)}
            >
              Review reason
            </Button>
          )}
        </>
      )}
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function PickReasonForm(
  props: Parameters<typeof PickReasonFormEnabled>[0],
) {
  return usePickReviewEnabled() ? <PickReasonFormEnabled {...props} /> : null;
}
