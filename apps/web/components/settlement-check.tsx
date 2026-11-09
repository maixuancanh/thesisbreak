"use client";
import { useMemo } from "react";
import { ShieldCheck } from "lucide-react";
import { checkSettlementRules } from "../../../packages/domain/src/settlement-rules";
import type { LiveMarket } from "../lib/live-market";
import { safeEvidenceUrl } from "../lib/pick-review-client";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "./ui/dialog";

const topicNames = { overtime: "Overtime & match length", cancellation: "Postponements & cancellations", authority: "Who decides the result", deadline: "Timing & deadlines" };
export function SettlementCheck({ market }: { market: LiveMarket }) {
  const check = useMemo(() => checkSettlementRules({
    rules: market.rules, sourceUrl: market.sourceUrl, observedAt: market.fetchedAt,
  }), [market.rules, market.sourceUrl, market.fetchedAt]);
  return (
    <section className="pick-intelligence-summary" aria-label="Settlement rules check">
      <ShieldCheck size={20} aria-hidden="true" />
      <div>
        <h2>Know what counts as a win</h2>
        <p>{check.state === "missing"
          ? "This source has not supplied the rules. Check them before recording a pick."
          : "Check the exact outcome, timing and exceptions before comparing odds."}</p>
      </div>
      <Dialog>
        <DialogTrigger asChild><Button variant="outline" size="sm">Check rules</Button></DialogTrigger>
        <DialogContent className="memory-dialog intelligence-dialog">
          <DialogTitle>What decides this market?</DialogTitle>
          <DialogDescription>Read the current source terms. Similar titles can have different settlement rules.</DialogDescription>
          {check.excerpts.length > 0 && <div className="intelligence-excerpts">
            {check.excerpts.map((excerpt, index) => <section key={index}>
              <h3>{topicNames[excerpt.topic]}</h3><blockquote>{excerpt.text}</blockquote>
            </section>)}
          </div>}
          <h3>Full rules</h3>
          <p className="intelligence-rules">{market.rules || "Rules have not been supplied by this source."}</p>
          <p className="small muted">Retrieved {new Date(market.fetchedAt).toLocaleString("en")}. Excerpts highlight source wording and may leave important conditions elsewhere in the full rules.</p>
          {safeEvidenceUrl(market.sourceUrl) && <a className="text-link" href={safeEvidenceUrl(market.sourceUrl)!} target="_blank" rel="noopener noreferrer">Read original market ↗</a>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
