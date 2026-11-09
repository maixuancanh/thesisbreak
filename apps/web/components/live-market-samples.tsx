"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "./ui/button";
import { markets, marketKey, type Platform } from "../lib/catalog";
import { Card } from "./market-card";
export function SampleDiscover() {
  const [platform, setPlatform] = useState<Platform>("Polymarket");
  const [category, setCategory] = useState("Football");
  const [search, setSearch] = useState("");
  const filtered = markets.filter(
    (m) =>
      m.platform === platform &&
      m.category === category &&
      m.question.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main id="main" className="page">
      <h1>Find your next pick</h1>
      <p className="lead">
        Choose a market. Add your view. Follow what matters.
      </p>
      <div className="search">
        <Search aria-hidden="true" />
        <input
          aria-label="Search fictional catalog"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this sample catalog"
        />
      </div>
      <p className="small muted">
        Search covers only these fictional fixtures. Live market links cannot be
        imported yet.
      </p>
      <div className="filters">
        <span>From</span>
        {(["Polymarket", "Kalshi"] as const).map((p) => (
          <Button
            key={p}
            variant={platform === p ? "secondary" : "outline"}
            aria-pressed={platform === p}
            onClick={() => setPlatform(p)}
          >
            {platform === p ? "✓ " : ""}
            {p}
          </Button>
        ))}
      </div>
      <div className="categories" aria-label="Category filters">
        {["Football", "Basketball", "Politics", "Crypto", "Economy"].map(
          (c) => (
            <Button
              key={c}
              variant={category === c ? "secondary" : "ghost"}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c}
            </Button>
          ),
        )}
      </div>
      <div className="section-title">
        <h2>{category}</h2>
        <span className="muted small">Fictional markets and prices</span>
      </div>
      {filtered.length ? (
        <div className="grid">
          {filtered.map((m) => (
            <Card key={marketKey(m)} m={m} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <h2>No sample markets match</h2>
          <p>Live {category.toLowerCase()} coverage has not been connected.</p>
          <Button
            onClick={() => {
              setCategory("Football");
              setSearch("");
            }}
          >
            Browse football samples
          </Button>
        </div>
      )}
    </main>
  );
}
