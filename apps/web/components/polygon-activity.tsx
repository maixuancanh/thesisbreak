"use client";

import { useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";

const responseSchema = z.object({
  data: z.object({
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    outcomes: z.array(
      z.object({
        name: z.string(),
        matchedOrders: z.number().int().nonnegative(),
        collateral: z.number().nonnegative(),
        averagePrice: z.number().min(0).max(1).nullable(),
        examples: z.array(
          z.object({
            transactionHash: z.string().regex(/^0x[\da-f]{64}$/i),
          }),
        ),
      }),
    ),
  }),
});

export function PolygonActivity({ marketId }: { marketId: string }) {
  const [activity, setActivity] =
    useState<z.infer<typeof responseSchema>["data"]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setBusy(true);
    setError("");
    setActivity(undefined);
    try {
      const query = new URLSearchParams({
        operation: "activity",
        platform: "polymarket",
        id: marketId,
      });
      const response = await fetch(`/api/markets/tatum-research?${query}`);
      if (!response.ok)
        throw Error("Polygon activity is unavailable right now.");
      setActivity(responseSchema.parse(await response.json()).data);
    } catch {
      setError("Polygon activity is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-evidence">
      <h3>Polygon trading activity</h3>
      <p className="small muted">
        Recent finalized matches for this market, checked through Tatum.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void check()}
      >
        {busy ? "Checking…" : activity ? "Refresh trades" : "Check trades"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {activity && (
        <>
          <p className="small muted">
            {new Date(activity.windowStart).toLocaleTimeString()}–
            {new Date(activity.windowEnd).toLocaleTimeString()} local time
          </p>
          {activity.outcomes.map((outcome) => (
            <article key={outcome.name}>
              <strong>{outcome.name}</strong>
              <p>
                {outcome.matchedOrders} matched orders ·{" "}
                {outcome.collateral.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}{" "}
                pUSD
              </p>
              {outcome.averagePrice !== null && (
                <p>
                  Average matched price{" "}
                  {(outcome.averagePrice * 100).toFixed(1)}¢
                </p>
              )}
              {[
                ...new Set(
                  outcome.examples.map((entry) => entry.transactionHash),
                ),
              ].map((hash, index) => (
                <p key={hash}>
                  <a
                    href={`https://polygonscan.com/tx/${hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Transaction {index + 1}
                  </a>
                </p>
              ))}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
