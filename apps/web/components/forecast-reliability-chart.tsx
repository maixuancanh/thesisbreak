import type { ReliabilityBin } from "../../../packages/domain/src/forecast-scorecard";
const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
export function ForecastReliabilityChart({ bins }: { bins: ReliabilityBin[] }) {
  const chartId = useId();
  return (
    <figure style={{ margin: "20px 0" }}>
      <figcaption>
        <strong>Probability reliability</strong>
        <p>
          Forecast probability compared with the observed home-win rate. Empty
          ranges have no observations. These are forecast probabilities, not
          market prices.
        </p>
      </figcaption>
      <svg
        viewBox="0 0 350 325"
        role="img"
        aria-labelledby={`${chartId}-title`}
        style={{
          width: "100%",
          maxWidth: 400,
          height: "auto",
          display: "block",
        }}
      >
        <title id={`${chartId}-title`}>
          Reliability plot: forecast probability on the horizontal axis,
          observed home-win rate on the vertical axis. Each dot is a populated
          probability range; exact counts follow in the table.
        </title>
        <path d="M50 20V270H320" fill="none" stroke="currentColor" />
        <path
          d="M50 270L320 20"
          fill="none"
          stroke="currentColor"
          strokeDasharray="5 5"
          opacity="0.4"
        />
        {[0, 0.5, 1].map((tick) => (
          <g key={tick} fill="currentColor" fontSize="11">
            <text x={50 + tick * 270} y="289" textAnchor="middle">
              {tick * 100}%
            </text>
            <text x="43" y={274 - tick * 250} textAnchor="end">
              {tick * 100}%
            </text>
          </g>
        ))}
        <text
          x="185"
          y="312"
          textAnchor="middle"
          fill="currentColor"
          fontSize="12"
        >
          Forecast probability
        </text>
        <text
          transform="translate(12 145) rotate(-90)"
          textAnchor="middle"
          fill="currentColor"
          fontSize="12"
        >
          Observed home-win rate
        </text>
        {bins
          .filter(
            (b) =>
              b.count > 0 &&
              b.meanProbability !== null &&
              b.observedRate !== null,
          )
          .map((b) => (
            <circle
              key={b.lower}
              cx={50 + b.meanProbability! * 270}
              cy={270 - b.observedRate! * 250}
              r="5"
              fill="currentColor"
            >
              <title>
                {b.count} events: mean forecast {percent(b.meanProbability)},
                observed wins {percent(b.observedRate)}
              </title>
            </circle>
          ))}
      </svg>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 360, textAlign: "left" }}>
          <caption className="sr-only">
            Events in each forecast probability range
          </caption>
          <thead>
            <tr>
              <th scope="col">Probability range</th>
              <th scope="col">Events</th>
              <th scope="col">Mean forecast</th>
              <th scope="col">Observed wins</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((bin, i) => (
              <tr key={bin.lower}>
                <th scope="row">
                  {Math.round(bin.lower * 100)}–{Math.round(bin.upper * 100)}%
                  {i === bins.length - 1 ? " (includes 100%)" : ""}
                </th>
                <td>{bin.count}</td>
                <td>{percent(bin.meanProbability)}</td>
                <td>{percent(bin.observedRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
import { useId } from "react";
