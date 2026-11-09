"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
const schema = z.object({
  points: z.array(
    z.object({ time: z.number(), price: z.number().min(0).max(1) }),
  ),
  noPoints: z
    .array(z.object({ time: z.number(), price: z.number().min(0).max(1) }))
    .optional(),
  basis: z.enum(["trade_close", "token_price"]),
});
const ranges = ["1H", "6H", "1D", "1W", "1M", "ALL"] as const;
export function MarketHistoryChart({
  platform,
  id,
}: {
  platform: string;
  id: string;
}) {
  const [range, setRange] = useState<(typeof ranges)[number]>("1W"),
    [data, setData] = useState<z.infer<typeof schema>["points"]>([]),
    [noData, setNoData] = useState<z.infer<typeof schema>["points"]>([]),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setBusy(true);
    setData([]);
    setNoData([]);
    setCursor(null);
    setError("");
    fetch(
      `/api/price-history?${new URLSearchParams({ platform, id, range })}`,
      { signal: c.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw Error();
        return schema.parse(await r.json());
      })
      .then((d) => {
        if (!c.signal.aborted) {
          setData(d.points);
          setNoData(
            d.basis === "trade_close"
              ? d.points.map((p) => ({ ...p, price: 1 - p.price }))
              : (d.noPoints ?? []),
          );
        }
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError("Price history is unavailable for this market.");
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => c.abort();
  }, [platform, id, range]);
  const start = Math.min(
      data[0]?.time ?? Infinity,
      noData[0]?.time ?? Infinity,
    ),
    end = Math.max(data.at(-1)?.time ?? 0, noData.at(-1)?.time ?? 0),
    px = (t: number) => 12 + ((t - start) / Math.max(1, end - start)) * 630,
    py = (p: number) => 280 - p * 250;
  const line = (no = false) =>
    (no ? noData : data)
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${px(p.time).toFixed(2)},${py(p.price).toFixed(2)}`,
      )
      .join(" ");
  const point = cursor === null ? data.at(-1) : data[cursor];
  const noPoint = point
    ? noData.reduce<(typeof noData)[number] | undefined>(
        (best, p) =>
          !best ||
          Math.abs(p.time - point.time) < Math.abs(best.time - point.time)
            ? p
            : best,
        undefined,
      )
    : undefined;
  return (
    <section className="chart-panel" aria-label="Market price history">
      <div className="chart-legend">
        <span>
          <i />
          Yes {point ? `${Math.round(point.price * 100)}%` : ""}
        </span>
        <span>
          <i />
          No {noPoint ? `${Math.round(noPoint.price * 100)}%` : ""}
        </span>
        {cursor !== null && point && (
          <span>{new Date(point.time * 1000).toLocaleString()}</span>
        )}
      </div>
      {busy || error || data.length < 2 ? (
        <div className="chart-state" role="status">
          {busy
            ? "Loading price history…"
            : error || "Not enough recorded trades in this period."}
        </div>
      ) : (
        <svg
          viewBox="0 0 760 320"
          role="img"
          tabIndex={0}
          aria-label={`${platform === "kalshi" ? "Yes trade close history and its No complement" : "Independent Yes and No token price histories"}. Use left and right arrow keys to inspect prices.`}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setCursor((previous) =>
                Math.max(
                  0,
                  Math.min(
                    data.length - 1,
                    (previous ?? data.length - 1) +
                      (e.key === "ArrowLeft" ? -1 : 1),
                  ),
                ),
              );
            }
            if (e.key === "Home") {
              e.preventDefault();
              setCursor(0);
            }
            if (e.key === "End") {
              e.preventDefault();
              setCursor(data.length - 1);
            }
          }}
          onPointerLeave={() => setCursor(null)}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const t =
              start +
              ((((e.clientX - rect.left) / rect.width) * 760 - 12) / 630) *
                (end - start);
            let nearest = 0;
            for (let i = 1; i < data.length; i++)
              if (
                Math.abs(data[i]!.time - t) < Math.abs(data[nearest]!.time - t)
              )
                nearest = i;
            setCursor(nearest);
          }}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line
                x1="12"
                x2="642"
                y1={py(v)}
                y2={py(v)}
                stroke="#dedee2"
                strokeDasharray="2 3"
              />
              <text x="710" y={py(v) + 4} fill="#aaaab0" fontSize="11">
                {Math.round(v * 100)}%
              </text>
            </g>
          ))}
          <path
            className="history-line"
            pathLength={1}
            d={line()}
            fill="none"
            stroke="#ff6464"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            className="history-line"
            pathLength={1}
            d={line(true)}
            fill="none"
            stroke="#389dff"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {point && (
            <g>
              {cursor !== null && (
                <line
                  x1={px(point.time)}
                  x2={px(point.time)}
                  y1="25"
                  y2="280"
                  stroke="#c8c8ce"
                  strokeDasharray="4 4"
                />
              )}
              {[point, noPoint].map((p, index) =>
                p ? (
                  <g key={index}>
                    <circle
                      cx={px(p.time)}
                      cy={py(p.price)}
                      r="9"
                      fill="none"
                      stroke={index ? "#389dff55" : "#ff646455"}
                    />
                    <circle
                      cx={px(p.time)}
                      cy={py(p.price)}
                      r="4"
                      fill={index ? "#389dff" : "#ff6464"}
                    />
                  </g>
                ) : null,
              )}
              <text
                x="654"
                y={py(point.price) + 5}
                fontSize="20"
                fontWeight="600"
                fill="#ff6464"
              >
                {Math.round(point.price * 100)}%
              </text>
              {noPoint && (
                <text
                  x="654"
                  y={py(noPoint.price) + 5}
                  fontSize="20"
                  fontWeight="600"
                  fill="#389dff"
                >
                  {Math.round(noPoint.price * 100)}%
                </text>
              )}
            </g>
          )}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <text
              key={f}
              x={12 + f * 630}
              y="308"
              textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
              fontSize="11"
              fill="#aaaab0"
            >
              {new Date((start + f * (end - start)) * 1000).toLocaleDateString(
                "en",
                { month: "short", day: "numeric" },
              )}
            </text>
          ))}
        </svg>
      )}
      <div className="chart-controls">
        {ranges.map((r) => (
          <button
            key={r}
            aria-pressed={r === range}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
      <p className="chart-caption">
        {platform === "kalshi"
          ? "Kalshi trade closes · No is the complement of Yes · Gaps have no recorded trade."
          : "Polymarket CLOB · Independent Yes and No token prices · Each line uses its own recorded timestamps."}
      </p>
    </section>
  );
}
