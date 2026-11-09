import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  evaluateChronological,
  fitTemporalTemperature,
  shadowPromotion,
} from "../packages/domain/src/forecast-model";
const args = process.argv.slice(2);
if (args.length !== 2)
  throw Error(
    "Usage: tsx scripts/evaluate-forecast-replay.ts corpus.json heldout-start-ISO",
  );
const manifest = z
  .object({
    namespace: z.string().regex(/^replay:/),
    importedAt: z.iso.datetime({ offset: true }),
    provenance: z
      .array(
        z.object({
          eventId: z.string(),
          forecastUrl: z.url(),
          publishedAt: z.iso.datetime({ offset: true }),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          officialResultUrl: z.url(),
        }),
      )
      .min(1),
    samples: z.array(z.unknown()).min(1),
  })
  .strict()
  .parse(JSON.parse(readFileSync(args[0]!, "utf8")));
const samples = manifest.samples as Parameters<typeof evaluateChronological>[0];
// Domain validation runs before splitting; provenance must demonstrate actual pre-event publication.
evaluateChronological(samples);
for (const s of samples) {
  const p = manifest.provenance.find((p) => p.eventId === s.eventId);
  if (
    !p ||
    Date.parse(p.publishedAt) > Date.parse(s.recordedAt) ||
    Date.parse(p.publishedAt) >= Date.parse(s.scheduledAt)
  )
    throw Error("MISSING_PRE_EVENT_PROVENANCE");
}
const boundary = z.iso.datetime({ offset: true }).parse(args[1]);
const train = samples.filter(
  (s) => Date.parse(s.resolvedAt) < Date.parse(boundary),
);
const heldout = samples.filter(
  (s) => Date.parse(s.recordedAt) >= Date.parse(boundary),
);
const calibration = fitTemporalTemperature(train, boundary),
  evaluation = evaluateChronological(heldout, calibration);
mkdirSync(".local", { recursive: true });
const result = {
  namespace: manifest.namespace,
  importedAt: manifest.importedAt,
  inputHash: createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex"),
  calibration,
  evaluation,
  shadow: shadowPromotion(evaluation),
  limitations: [
    "Historical replay, not prospective live performance",
    "Provenance URLs/hashes supplied by importer require independent review",
    "Not an LLM/Walrus paired grounding evaluation",
  ],
};
writeFileSync(
  ".local/forecast-replay-results.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    events: evaluation.events,
    paired: evaluation.pairedEvents,
    decision: result.shadow.status,
  }),
);
