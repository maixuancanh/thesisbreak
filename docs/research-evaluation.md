# Paired research regression evaluation

Run `pnpm eval:research --live-model` to compare the configured model with and without an existing approved memory read from Walrus. The script reuses the labelled acceptance account, performs no remote memory writes, and invokes eight bounded model calls: four scenarios with one sample per variant. It stores replies and per-case failures in the ignored `.local/research-evaluation.json`. Failures are not silently retried or excluded from the denominator; partial progress is preserved separately.

The fixed synthetic scenarios cover rumor-only, price-only, an exact official Out report, and an exact official starter sheet. They are written before the run with expected unclear/unclear/contradicted/supported labels. Each variant gets the same source text, user request, pick and model, and a fresh empty history. Only the approved lesson context differs. The call order alternates between variants. The evaluator checks a single verbatim saved-reason claim, its label, direct-evidence reference when required, strict output validity and absence of pick mutations. These are structural regression metrics, not a judge of free-text reasoning quality, a prediction backtest, a held-out statistical benchmark or evidence of general improvement.

## Recorded result,26 October

| Variant | Cases | Valid replies | Expected label + citation | No pick mutation | Memory references |
|---|---:|---:|---:|---:|---:|
| Without memory |4|4|4|4|0|
| With approved remote memory |4|4|4|4|4|

There was no label-score improvement in this small run. Memory references confirm use of the supplied approved lesson, not better decisions or causal learning. Replies still require human review for substantive relevance and unsupported claims. The suite is intentionally reproducible regression coverage; broader held-out scenarios, repeated samples, independent blinded review and a separately configured second model remain pending.
