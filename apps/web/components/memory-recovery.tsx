"use client";
import { useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
const summarySchema = z.object({
  expectedRecords: z.number(),
  verifiedDistinctLessons: z.number(),
  rejectedRecords: z.number(),
  completeness: z.string(),
  missingRecords: z.number().nullable().optional(),
  truncated: z.boolean(),
});
export function MemoryRecovery() {
  const [result, setResult] = useState("");
  const [summary, setSummary] = useState<z.infer<typeof summarySchema> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  async function run(restore: boolean) {
    setBusy(true);
    setSummary(null);
    setResult("");
    try {
      const r = await fetch(
        "/api/memory/recovery",
        restore
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirmed: true }),
            }
          : { cache: "no-store" },
      );
      const data = await r.json();
      if (!r.ok) throw new Error("RECOVERY_UNAVAILABLE");
      const parsed = summarySchema.parse(data);
      setSummary(parsed);
      setResult(
        parsed.completeness === "expected_inventory_verified"
          ? "Your recorded archive was found. Paused and retired preferences remain excluded."
          : restore
            ? "Recovery is incomplete or could not verify every record. No account permissions were changed."
            : "Inventory checked against saved receipts. This does not perform a fresh remote read.",
      );
    } catch {
      setResult("Recovery unavailable. Completeness unknown.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Memory recovery">
      <h3>Memory recovery</h3>
      <p>
        Rebuild the remote search index and check the owned archive. Your lesson
        approvals and pauses stay under database control.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void run(false)}>
        Check saved memories
      </Button>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I confirm rebuilding my remote memory index.
      </label>
      <Button disabled={busy || !confirmed} onClick={() => void run(true)}>
        Restore and verify
      </Button>
      {summary && (
        <p>
          {summary.verifiedDistinctLessons} distinct preferences with verified
          storage receipts · {summary.expectedRecords} recorded versions
          {summary.rejectedRecords
            ? ` · ${summary.rejectedRecords} records need attention`
            : ""}
          {summary.truncated ? " · Inventory exceeds this check's limit" : ""}
        </p>
      )}
      <p role="status">{busy ? "Checking your archive…" : result}</p>
    </section>
  );
}
