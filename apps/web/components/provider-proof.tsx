"use client";
import { useState } from "react";
import type { ProviderProofStatus } from "../lib/server/provider-proof-service";
export function ProviderProof() {
  const [result, setResult] = useState<ProviderProofStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/providers/proof", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      setResult((await response.json()) as ProviderProofStatus);
    } catch {
      setError("Account check unavailable. Sign in and try again.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Sui account verification">
      <h3>Sui account verification</h3>
      <p>
        Read the configured MemWal account through Tatum to check its network,
        object type and recorded owner.
      </p>
      <button disabled={busy} onClick={() => void check()}>
        {busy ? "Checking account…" : "Check account"}
      </button>
      <div role="status" aria-live="polite">
        {error && <p>{error}</p>}
        {result && (
          <p>
            {result.status === "verified"
              ? "Account observed on Sui Mainnet through Tatum."
              : result.status === "blocked"
                ? "Account check blocked: server configuration is incomplete."
                : "Account could not be verified."}
          </p>
        )}
        {result?.latestProof && (
          <p>
            Checked {new Date(result.latestProof.checkedAt).toLocaleString()}.
            Object version {result.latestProof.objectVersion}.
          </p>
        )}
      </div>
      <p>
        This observation does not prove signing authority, delegate access,
        memory retrieval or archive completeness.
      </p>
    </section>
  );
}
