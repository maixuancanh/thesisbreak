"use client";
import { useState } from "react";
import { z } from "zod";
import { type ResearchResult, toolNames } from "../lib/agent-client";
import { Button } from "./ui/button";
const receiptResponse = z.object({
  data: z
    .object({
      publication: z.enum([
        "not_requested",
        "pending",
        "published",
        "verified",
        "failed",
      ]),
      proof: z.object({
        blobId: z.string().nullable(),
        readbackHash: z.string().nullable(),
        exactRecordBinding: z.literal("unsupported"),
      }),
      suiAccountProof: z
        .object({
          accountId: z.string().regex(/^0x[\da-f]{64}$/i),
          checkedAt: z.iso.datetime(),
          version: z.string(),
          checkpoint: z.string(),
        })
        .nullish(),
      receipt: z.object({
        modelVersion: z.string(),
        promptVersion: z.string(),
        memories: z.array(
          z.object({ id: z.string(), version: z.number(), hash: z.string() }),
        ),
      }),
      userDecisionReceipts: z
        .array(
          z.object({
            id: z.string(),
            userDecision: z.enum(["confirmed", "rejected"]),
            publication: z.enum([
              "not_ready",
              "not_requested",
              "pending",
              "published",
              "verified",
              "failed",
            ]),
            receipt: z
              .object({
                sourceReceipt: z.object({ id: z.string(), hash: z.string() }),
              })
              .nullable(),
          }),
        )
        .optional(),
    })
    .nullable(),
});
const dossierLabels = {
  fresh: "Event notes checked against their supporting evidence.",
  partial: "Event notes are incomplete; missing evidence still needs checking.",
  stale: "Event notes need a fresh check because supporting evidence changed.",
  empty: "No saved event notes were available.",
  failed_refresh:
    "Event notes could not be refreshed. This reply must rely on the checks shown.",
};
export function LearningProof({
  result,
  runId,
}: {
  result: ResearchResult;
  runId: string;
}) {
  const [record, setRecord] = useState<
    z.infer<typeof receiptResponse>["data"] | undefined
  >();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/agent/runs/${encodeURIComponent(runId)}/receipt`,
        { cache: "no-store" },
      );
      if (!response.ok) throw Error("Receipt is unavailable. Try again later.");
      setRecord(receiptResponse.parse(await response.json()).data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Receipt unavailable.");
    } finally {
      setBusy(false);
    }
  }
  const required = result.policyRequiredTools ?? [];
  return (
    <section>
      <h4>What I remembered and checked</h4>
      <p>
        {result.learningGate?.ready === false
          ? "I am waiting for the checks your approved rules require."
          : result.reply.proposedChange || result.reply.proposedPick
            ? "I am proposing a change for your review. Your saved pick has not changed."
            : "Your saved pick has not changed."}
      </p>
      {result.eventDossierState && (
        <p>{dossierLabels[result.eventDossierState]}</p>
      )}
      {result.evidenceDebate && result.evidenceDebate.status !== "skipped" && (
        <section aria-label="Review from both sides">
          <p>
            <strong>Review from both sides</strong>
          </p>
          <p>
            {result.evidenceDebate.result?.explanation ??
              "The review could not finish. Your saved pick is unchanged."}
          </p>
          <p>
            {result.evidenceDebate.independentOrigins} distinct source origin(s)
            checked. Multiple opinions using the same source count as one
            origin.
          </p>
          {!!result.evidenceDebate.result?.missingChecks.length && (
            <p>
              Still needed:{" "}
              {result.evidenceDebate.result.missingChecks
                .join(", ")
                .replaceAll("_", " ")}
              .
            </p>
          )}
        </section>
      )}
      {!!required.length && (
        <>
          <p>Required by your approved rules:</p>
          <ul>
            {required.map((tool) => {
              const trace = result.trace.find((t) => t.tool === tool);
              return (
                <li key={tool}>
                  {toolNames[tool] ?? tool.replaceAll("_", " ")}:{" "}
                  {trace?.status === "completed" ||
                  trace?.status === "succeeded"
                    ? "checked"
                    : trace?.status === "unavailable"
                      ? "unavailable — waiting"
                      : "not completed"}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!!result.plannedTools?.length && (
        <p>
          Chosen for this question:{" "}
          {result.plannedTools
            .map((tool) => toolNames[tool] ?? tool.replaceAll("_", " "))
            .join("; ")}
          .
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy
          ? "Checking receipt…"
          : record === undefined
            ? "View saved receipt"
            : "Refresh receipt"}
      </Button>
      {record === null && (
        <p role="status">
          The receipt is not ready yet. A saved reply does not mean its receipt
          has been published.
        </p>
      )}
      {record && (
        <>
          <p>
            {record.publication === "verified"
              ? "Receipt stored in Walrus and read back with a matching hash."
              : record.publication === "not_requested"
                ? "Receipt saved locally. Remote publication was not requested."
                : record.publication === "failed"
                  ? "Receipt publication failed. The local record remains available."
                  : "Receipt publication or readback is still pending."}
          </p>
          <p>
            {record.receipt.memories.length} verified memory version(s)
            recorded. Exact onchain transaction binding is unavailable.
          </p>
          {record.userDecisionReceipts?.map((decision) => (
            <p key={decision.id}>
              Your later decision:{" "}
              {decision.userDecision === "confirmed"
                ? "confirmed the change"
                : "kept your pick"}
              .{" "}
              {decision.publication === "verified"
                ? "Decision receipt read back from Walrus."
                : decision.publication === "not_requested"
                  ? "Decision receipt saved locally."
                  : decision.publication === "not_ready"
                    ? "Decision receipt is being prepared."
                    : "Decision receipt publication is pending."}
              {decision.receipt && (
                <span> Linked to the original receipt.</span>
              )}
            </p>
          ))}
          <section>
            <h5>Proof details</h5>
            {record.suiAccountProof && (
              <p>
                Tatum verified the configured Walrus account on Sui Mainnet at
                checkpoint {record.suiAccountProof.checkpoint}, object version{" "}
                {record.suiAccountProof.version}.{" "}
                <a
                  href={`https://suiscan.xyz/mainnet/object/${record.suiAccountProof.accountId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View Sui account
                </a>
                . This account check is separate from the blob readback below.
              </p>
            )}
            <p>
              Model: {record.receipt.modelVersion} · Prompt:{" "}
              {record.receipt.promptVersion}
            </p>
            {record.proof.blobId && (
              <p>
                Walrus blob: <code>{record.proof.blobId}</code>
              </p>
            )}
            {record.proof.readbackHash && (
              <p>
                Readback hash: <code>{record.proof.readbackHash}</code>
              </p>
            )}
            {record.receipt.memories.map((m) => (
              <p key={`${m.id}:${m.version}`}>
                Memory {m.id} · version {m.version} · <code>{m.hash}</code>
              </p>
            ))}
          </section>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
