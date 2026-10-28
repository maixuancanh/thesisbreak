"use client";
export function ActivityStat({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  return (
    <div className="activity-stat">
      <span className="activity-value" aria-label={String(value)}>
        <span aria-hidden="true" className="rolling-digits">
          {String(value)
            .split("")
            .map((d, i) => (
              <span className="digit-window" key={i}>
                <span
                  className="digit-strip"
                  style={{ transform: `translateY(-${Number(d)}em)` }}
                >
                  {Array.from({ length: 10 }, (_, n) => (
                    <span key={n}>{n}</span>
                  ))}
                </span>
              </span>
            ))}
        </span>
      </span>
      <span>{label}</span>
    </div>
  );
}
