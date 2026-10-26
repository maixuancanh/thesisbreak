"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { LiveMarketDiscover } from "./live-market-discover";
import { SampleDiscover } from "./live-market-samples";
export function Discover() {
  const [samples, setSamples] = useState(false);
  return (
    <>
      <details className="sample-disclosure">
        <summary>
          Preview options{samples ? " · Fictional samples active" : ""}
        </summary>
        <p className="small muted">
          Sample markets are fictional and separate from live sources.
        </p>
        <Button variant="outline" onClick={() => setSamples(!samples)}>
          {samples ? "Return to live markets" : "Open fictional sample preview"}
        </Button>
      </details>
      {samples ? <SampleDiscover /> : <LiveMarketDiscover />}
    </>
  );
}
