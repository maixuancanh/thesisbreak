import type { normalizeBookmakerEvent } from "./bookmaker";
import type { TatumQuote } from "./tatum/research";
import type { readPolygonActivity } from "./tatum/polygon-activity";

/** Explicitly reviewed metadata, never inferred from a question's team-name substrings. */
export type ReviewedWinnerMapping = {
  marketId: string;
  platform: TatumQuote["platform"];
  home: string;
  away: string;
  scheduledAt: string;
  marketType: string;
  yesOutcome: string;
  noOutcome: string;
  sourceUrl: string;
  reviewedAt: string;
};
export type ReviewedWinnerRules = {
  sourceUrl: string;
  reviewedAt: string;
  overtime: string;
  postponement: string;
  abandonment: string;
};
type QuoteObservation = {
  provider: "tatum";
  fetchedAt: string;
  data: Pick<TatumQuote, "marketId" | "platform" | "timestamp"> & {
    yes: Pick<TatumQuote["yes"], "price">;
    no: Pick<TatumQuote["no"], "price">;
  };
};

/**
 * Descriptive comparison only. API prices, reviewed mappings and reviewed rule
 * summaries do not establish onchain settlement or externally verified rules.
 * This function never fetches, trades, changes a pick or invents missing evidence.
 */
export function compareBookmakerMarket(input: {
  bookmaker: ReturnType<typeof normalizeBookmakerEvent>;
  bookmakerKey: string;
  market: QuoteObservation;
  mapping: ReviewedWinnerMapping | null;
  rules: { bookmaker: ReviewedWinnerRules; market: ReviewedWinnerRules } | null;
  now: Date;
}) {
  const { bookmaker, market, mapping, rules, now } = input;
  const time = now.getTime();
  const citation = (sourceUrl: string, reviewedAt: string) => {
    try {
      const url = new URL(sourceUrl);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        Number.isFinite(Date.parse(reviewedAt)) &&
        Date.parse(reviewedAt) <= time
      );
    } catch {
      return false;
    }
  };
  const candidates = bookmaker.quotes.filter(
    (q) => q.bookmaker === input.bookmakerKey,
  );
  const quote = candidates.length === 1 ? candidates[0] : undefined;
  const identity =
    !mapping || !citation(mapping.sourceUrl, mapping.reviewedAt)
      ? "unverified"
      : mapping.marketId === market.data.marketId &&
          mapping.platform === market.data.platform &&
          mapping.home === bookmaker.home &&
          mapping.away === bookmaker.away &&
          Number.isFinite(Date.parse(mapping.scheduledAt)) &&
          Date.parse(mapping.scheduledAt) === Date.parse(bookmaker.scheduledAt)
        ? "matched"
        : "different";
  const outcome =
    !mapping || !citation(mapping.sourceUrl, mapping.reviewedAt)
      ? "unverified"
      : mapping.marketType === "full_game_winner" &&
          ((mapping.yesOutcome === bookmaker.home &&
            mapping.noOutcome === bookmaker.away) ||
            (mapping.yesOutcome === bookmaker.away &&
              mapping.noOutcome === bookmaker.home))
        ? "matched"
        : "different";
  const supported = (r: ReviewedWinnerRules) =>
    citation(r.sourceUrl, r.reviewedAt) &&
    ["included", "excluded"].includes(r.overtime) &&
    ["void", "rescheduled", "split"].includes(r.postponement) &&
    ["void", "official_result", "split"].includes(r.abandonment);
  const ruleAlignment =
    !rules || !supported(rules.bookmaker) || !supported(rules.market)
      ? "unverified"
      : rules.bookmaker.overtime === rules.market.overtime &&
          rules.bookmaker.postponement === rules.market.postponement &&
          rules.bookmaker.abandonment === rules.market.abandonment
        ? "reviewed_compatible"
        : "different";
  const times = [
    quote?.asOf,
    bookmaker.fetchedAt,
    market.data.timestamp,
    market.fetchedAt,
  ];
  const sourceTimes = times.map((t) => Date.parse(t ?? ""));
  const freshness =
    !Number.isFinite(time) || sourceTimes.some((t) => !Number.isFinite(t))
      ? "unavailable"
      : sourceTimes.some((t) => t > time)
        ? "future"
        : sourceTimes.some((t) => time - t > 300_000)
          ? "stale"
          : Math.abs(sourceTimes[0]! - sourceTimes[2]!) > 120_000
            ? "unsynchronized"
            : "fresh";
  const probability = quote?.outcomes.find(
    (o) => o.name === bookmaker.home,
  )?.probability;
  const price =
    mapping?.yesOutcome === bookmaker.home
      ? market.data.yes.price
      : market.data.no.price;
  const validProbability = (p: number | undefined) =>
    p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1;
  const validQuote =
    !!quote &&
    quote.outcomes.length === 2 &&
    quote.outcomes.filter((o) => o.name === bookmaker.home).length === 1 &&
    quote.outcomes.filter((o) => o.name === bookmaker.away).length === 1 &&
    quote.outcomes.every(
      (o) =>
        validProbability(o.probability) &&
        Number.isFinite(o.decimalOdds) &&
        o.decimalOdds > 1,
    ) &&
    Math.abs(quote.outcomes.reduce((sum, o) => sum + o.probability, 0) - 1) <
      1e-9;
  const eventStarted =
    Number.isFinite(Date.parse(bookmaker.scheduledAt)) &&
    time >= Date.parse(bookmaker.scheduledAt);
  const status =
    identity === "different" ||
    outcome === "different" ||
    ruleAlignment === "different" ||
    eventStarted
      ? "incompatible"
      : identity === "matched" &&
          outcome === "matched" &&
          ruleAlignment === "reviewed_compatible" &&
          freshness === "fresh" &&
          validQuote &&
          validProbability(price) &&
          validProbability(market.data.yes.price) &&
          validProbability(market.data.no.price)
        ? "reviewed_compatible"
        : "incomplete";
  return {
    status,
    identity,
    outcome,
    rules: ruleAlignment,
    freshness,
    eventStarted,
    homeProbabilityGap:
      status === "reviewed_compatible" ? price - probability! : null,
    bookmakerHomeProbability: validQuote ? probability! : null,
    marketHomePrice:
      outcome === "matched" && validProbability(price) ? price : null,
    settlementRulesVerified: false as const,
    chainVerified: false as const,
    marketEvidence: "tatum_api_quote" as const,
    policy: { maximumAgeSeconds: 300, maximumSkewSeconds: 120 },
    ruleScope:
      "reviewed overtime, postponement and abandonment summaries; full provider-rule equivalence not verified",
    interpretation:
      "Descriptive price difference only; no executable edge or predictive improvement established.",
    provenance: {
      bookmakerProvider: bookmaker.provider,
      bookmakerEventId: bookmaker.eventId,
      bookmaker: input.bookmakerKey,
      bookmakerAsOf: quote?.asOf ?? null,
      bookmakerFetchedAt: bookmaker.fetchedAt,
      bookmakerOutcomes: quote?.outcomes ?? null,
      marketId: market.data.marketId,
      platform: market.data.platform,
      marketAsOf: market.data.timestamp,
      marketFetchedAt: market.fetchedAt,
      marketPrices: { yes: market.data.yes.price, no: market.data.no.price },
      mapping: mapping
        ? { sourceUrl: mapping.sourceUrl, reviewedAt: mapping.reviewedAt }
        : null,
      rules,
    },
  };
}

export function compareBookmakerWithPolygon(input: {
  bookmaker: ReturnType<typeof normalizeBookmakerEvent>;
  bookmakerKey: string;
  marketId: string;
  activity: Awaited<ReturnType<typeof readPolygonActivity>>;
  mapping: ReviewedWinnerMapping | null;
  rules: { bookmaker: ReviewedWinnerRules; market: ReviewedWinnerRules } | null;
  now: Date;
}) {
  const { activity, bookmaker, mapping } = input;
  const yes = activity.outcomes.find(
    (outcome) => outcome.name === mapping?.yesOutcome,
  );
  const no = activity.outcomes.find(
    (outcome) => outcome.name === mapping?.noOutcome,
  );
  const home = mapping?.yesOutcome === bookmaker.home ? yes : no;
  const reviewed = compareBookmakerMarket({
    ...input,
    market: {
      provider: "tatum",
      fetchedAt: activity.windowEnd,
      data: {
        platform: "polymarket",
        marketId: input.marketId,
        timestamp: activity.windowEnd,
        yes: { price: yes?.averagePrice ?? NaN },
        no: { price: no?.averagePrice ?? NaN },
      },
    },
  });
  const observedAt = Date.parse(reviewed.provenance.bookmakerAsOf ?? "");
  const start = Date.parse(activity.windowStart);
  const end = Date.parse(activity.windowEnd);
  const aligned =
    Number.isFinite(observedAt) &&
    start <= end &&
    Math.max(Math.abs(start - observedAt), Math.abs(end - observedAt)) <=
      120_000 &&
    Math.abs(Date.parse(bookmaker.fetchedAt) - observedAt) <= 300_000 &&
    end < Date.parse(bookmaker.scheduledAt) &&
    observedAt < Date.parse(bookmaker.scheduledAt) &&
    Date.parse(bookmaker.fetchedAt) < Date.parse(bookmaker.scheduledAt) &&
    Math.max(end, observedAt, Date.parse(bookmaker.fetchedAt)) <=
      input.now.getTime();
  const comparable =
    activity.conditionId === input.marketId &&
    aligned &&
    reviewed.identity === "matched" &&
    reviewed.outcome === "matched" &&
    reviewed.rules === "reviewed_compatible" &&
    reviewed.bookmakerHomeProbability !== null &&
    home?.averagePrice != null &&
    home.examples.length > 0;
  return {
    status: comparable ? "comparable" : "incomplete",
    identity: reviewed.identity,
    outcome: reviewed.outcome,
    rules: reviewed.rules,
    aligned,
    bookmakerHomeProbability: reviewed.bookmakerHomeProbability,
    polygonHomePrice: home?.averagePrice ?? null,
    homeProbabilityGap: comparable
      ? home.averagePrice! - reviewed.bookmakerHomeProbability!
      : null,
    activity,
    provenance: reviewed.provenance,
  };
}
