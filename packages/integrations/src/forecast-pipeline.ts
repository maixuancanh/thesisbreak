import { z } from "zod";
import {
  eloHomeProbability,
  ratingsBefore,
  type EloGame,
  type EloConfig,
} from "../../domain/src/forecast-model";
import { assessResearchReadiness } from "../../domain/src/research-policy";
/** Pure capture preparation. The database is the only authority for live capture time. */
export function prepareNbaForecast(input: {
  asOf: string;
  homeTeam: string;
  awayTeam: string;
  homeRestDays: number;
  awayRestDays: number;
  games: EloGame[];
  config: EloConfig;
  requiresLineup: boolean;
  lineupConfirmed: boolean;
  staleEvidence: boolean;
  conflictingEvidence: boolean;
  evidenceRefs: string[];
}) {
  z.iso.datetime({ offset: true }).parse(input.asOf);
  if (
    !input.homeTeam.trim() ||
    !input.awayTeam.trim() ||
    input.homeTeam === input.awayTeam
  )
    throw Error("INVALID_TEAMS");
  const history = ratingsBefore(input.games, input.asOf, input.config);
  const readiness = assessResearchReadiness({
    requiresLineup: input.requiresLineup,
    lineupConfirmed: input.lineupConfirmed,
    staleEvidence: input.staleEvidence,
    conflictingEvidence: input.conflictingEvidence,
    evidenceRefs: input.evidenceRefs,
  });
  const estimate = eloHomeProbability(
    {
      homeRating:
        history.ratings[input.homeTeam] ?? input.config.initialRating ?? 1500,
      awayRating:
        history.ratings[input.awayTeam] ?? input.config.initialRating ?? 1500,
      homeRestDays: input.homeRestDays,
      awayRestDays: input.awayRestDays,
    },
    input.config,
  );
  return {
    methodVersion: "nba-elo-shadow-v1",
    asOf: input.asOf,
    probability: readiness.action === "ready" ? estimate : null,
    abstentionReason:
      readiness.action === "ready" ? null : readiness.reasons.join(","),
    readiness,
    trainingEventIds: history.usedEventIds,
    validatedPredictiveImprovement: false,
  };
}
