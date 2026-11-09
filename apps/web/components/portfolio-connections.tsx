"use client";
import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import { z } from "zod";
import { portfolioGroupSchema } from "../../../packages/domain/src/portfolio-reasons";
import { Button } from "./ui/button";
import { PagedList } from "./paged-list";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./ui/dialog";

const responseSchema = z.object({ groups: z.array(portfolioGroupSchema.extend({ mode: z.string() })), checkedPicks: z.number(), limit: z.number() });
export function PortfolioConnections() {
  const [data, setData] = useState<z.infer<typeof responseSchema> | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setData(null);
    void fetch("/api/picks/connections", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error();
        const value = responseSchema.parse(await response.json());
        if (!controller.signal.aborted) setData(value);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [reload]);
  const groups = data?.groups ?? [];
  return <section className="pick-intelligence-summary" aria-label="Connected picks">
    <Network size={20} aria-hidden="true" />
    <div><h2>What connects your picks?</h2>
      <p>{failed ? "Connections could not be checked." : !data ? "Checking your active picks…" : groups.length
        ? `${groups.length} shared ${groups.length === 1 ? "reason or condition" : "reasons or conditions"} to review together.`
        : "No exact shared reason or condition found in your latest active picks."}</p>
    </div>
    {failed ? <Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>Retry</Button> : data && <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm">View connections</Button></DialogTrigger>
      <DialogContent className="memory-dialog intelligence-dialog">
        <DialogTitle>Review connected picks</DialogTitle>
        <DialogDescription>Shared reasons can make several picks worth reviewing together. This check uses exact saved text and confirmed conditions, and does not estimate financial correlation.</DialogDescription>
        <p className="small muted">Checked {data.checkedPicks} active picks, up to the latest {data.limit}.</p>
        {!groups.length && <p>No exact matches found. Different wording or unrecorded assumptions can hide other connections.</p>}
        <PagedList items={groups} size={3} label="Connection pages">
          {(group, index) => <article className="intelligence-group" key={index}>
            <h3>{group.picks.length} picks · {group.kind === "same_condition" ? "Same confirmed condition" : "Same saved reason"}</h3>
            {group.mode !== "live" && <p className="small muted">{group.mode.replaceAll("_", " ")}</p>}
            <p>{group.reason}</p>
            <ul>{group.picks.map((pick) => <li key={pick.id}>
              <DialogClose asChild><a className="text-link" href={`/picks#pick-${pick.id}`}>{pick.question} · {pick.outcome}</a></DialogClose>
            </li>)}</ul>
          </article>}
        </PagedList>
      </DialogContent>
    </Dialog>}
  </section>;
}
