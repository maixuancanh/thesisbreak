import type { ForecastScorecard as Scorecard } from "../../../packages/domain/src/forecast-scorecard";
import { ForecastReliabilityChart } from "./forecast-reliability-chart";
const metric = (value: number | null) =>
  value === null ? "Not available" : value.toFixed(3);
const percent = (value: number | null) =>
  value === null ? "Not available" : `${Math.round(value * 100)}%`;
const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString() : "No events";
export function ForecastScorecard({ card }: { card: Scorecard }) {
  return (
    <section className="panel" style={{ margin: "24px 0" }}>
      <h2>
        Forecast scorecard ·{" "}
        {card.horizon === "T24h"
          ? "24 hours before tip-off"
          : card.horizon === "T60m"
            ? "60 minutes before tip-off"
            : card.horizon}
      </h2>
      <p>
        Method: {card.methodVersion}. Event dates: {date(card.range.from)} –{" "}
        {date(card.range.to)}.
      </p>
      {card.status === "insufficient_settled_events" && (
        <p role="status">
          Not enough settled events yet. Scores below describe the available
          sample.
        </p>
      )}
      <p>
        {card.counts.settledEvents} settled events from{" "}
        {card.counts.capturedEvents} captured events ·{" "}
        {card.counts.predictedEvents} scored forecasts ·{" "}
        {card.counts.pairedEvents} paired with a saved baseline.
      </p>
      <p>
        Forecast coverage: {percent(card.coverage.model)} · Paired coverage:{" "}
        {percent(card.coverage.paired)}. Both use {card.coverage.denominator}{" "}
        settled captured events as their denominator.
      </p>
      <p>
        {card.counts.abstainedEvents} abstained · {card.counts.failedEvents}{" "}
        failed · {card.counts.unresolvedEvents} awaiting results ·{" "}
        {card.counts.missingBaselines} settled events without a baseline ·{" "}
        {card.counts.excludedResults} void or disputed.
      </p>
      {card.counts.unavailableLabels > 0 && (
        <p>
          {card.counts.unavailableLabels} labels were not available at the
          report time and are excluded.
        </p>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 330, textAlign: "left" }}>
          <caption>
            Scores on the same {card.paired.events} paired events. Lower Brier
            and log loss are better.
          </caption>
          <thead>
            <tr>
              <th scope="col">Saved forecast</th>
              <th scope="col">Brier</th>
              <th scope="col">Log loss</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Model probability</th>
              <td>{metric(card.paired.modelBrier)}</td>
              <td>{metric(card.paired.modelLogLoss)}</td>
            </tr>
            <tr>
              <th scope="row">Baseline probability</th>
              <td>{metric(card.paired.baselineBrier)}</td>
              <td>{metric(card.paired.baselineLogLoss)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Paired Brier difference (model minus baseline):{" "}
        {metric(card.paired.brierDelta)}.
        {card.paired.interval
          ? ` Descriptive 95% interval: ${metric(card.paired.interval.lower)} to ${metric(card.paired.interval.upper)}.`
          : " Not enough paired events to estimate an interval."}
      </p>
      <p>
        Improved predictive accuracy has not been demonstrated. Each method and
        horizon is reported separately; this sample does not establish
        performance on future events.
      </p>
      <details>
        <summary>Reliability and evaluation details</summary>
        <p>
          All available model forecasts: {card.model.events} events, Brier{" "}
          {metric(card.model.brier)}, log loss {metric(card.model.logLoss)},
          calibration error {metric(card.model.ece)}.
        </p>
        <p>
          All available baselines: {card.baseline.events} events, Brier{" "}
          {metric(card.baseline.brier)}, log loss{" "}
          {metric(card.baseline.logLoss)}. These denominators can differ; use
          the paired table for comparison.
        </p>
        <ForecastReliabilityChart bins={card.reliability} />
        <p>
          {card.protocol.unit} {card.protocol.baseline} {card.protocol.coverage}
        </p>
        <p>
          {card.protocol.statusThreshold} Log loss clips numerical boundaries at{" "}
          {card.protocol.logLossEpsilon}; original probabilities remain
          unchanged.
        </p>
        <p>
          {card.paired.interval?.assumption ??
            "No uncertainty interval is available with fewer than two paired events."}
        </p>
        <p>
          Intervals use 2,000 deterministic event bootstrap samples within this
          cohort. They are descriptive and do not account for model selection,
          multiple comparisons or dependence between games.
        </p>
      </details>
    </section>
  );
}
