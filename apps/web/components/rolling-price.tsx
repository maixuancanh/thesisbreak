"use client";

/** Decimal columns animate only when a real source quote changes. */
export function RollingPrice({ price }: { price: number | null }) {
  if (price === null) return <span className="quote-unavailable">—</span>;
  const value = Math.round(price * 100);
  return (
    <span className="rolling-price" aria-label={`${value}%`}>
      <span aria-hidden="true" className="rolling-digits">
        {String(value)
          .split("")
          .map((digit, index) => (
            <span className="digit-window" key={index}>
              <span
                className="digit-strip"
                style={{ transform: `translateY(-${Number(digit)}em)` }}
              >
                {Array.from({ length: 10 }, (_, n) => (
                  <span key={n}>{n}</span>
                ))}
              </span>
            </span>
          ))}
        <span className="quote-percent">%</span>
      </span>
    </span>
  );
}

export function QuoteBar({
  price,
  index = 0,
}: {
  price: number | null;
  index?: number;
}) {
  return (
    <span className={`quote-track quote-color-${index % 3}`} aria-hidden="true">
      <span style={{ transform: `scaleX(${price ?? 0})` }} />
    </span>
  );
}
