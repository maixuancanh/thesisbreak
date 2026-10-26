# Agent runtime

The agent package uses Vercel AI SDK `ai@7.0.148` and the maintained `@ai-sdk/openai-compatible@3.0.75` provider binding. It does not implement its own model transport. The configured provider must support the structured output requested by the SDK; real provider compatibility remains unverified without credentials.

`createAgentContext` accepts resources loaded by an authenticated server. It validates the current user and exact platform/market identity for the pick and evidence, then applies the deterministic lesson policy. Request bodies must never be used as authoritative context. Evidence identity and content still need verified source ingestion; the builder cannot prove that a caller's observation is true.

`answerWithContext` asks Thesis to challenge assumptions, distinguish evidence from interpretation, and acknowledge missing information. The generation response has a message, supplied evidence references, applicable lesson references and an optional version-bound change draft. Unknown citations, stale base versions, unknown outcomes and empty proposals are rejected. A valid draft does not save a pick or authorize a future lesson. No mutation or purchase tool is exposed.

The system prompt labels source/user text as untrusted. That instruction helps model behavior but is not a security boundary; authorization and confirmation must remain in application code. Validating a reference's existence does not establish that it supports every sentence. Citation support and reasoning quality require the later evaluation gate.

Provider calls are server-only, time-bounded, output-limited and have no automatic retries. Errors are replaced with a fixed message so provider bodies and credentials do not leak. The base URL must use HTTPS, with HTTP localhost allowed only outside production. The actual model ID is explicit; none is silently selected.

Applicable lesson envelopes are capped at 12,000 serialized characters each, and the aggregate model prompt at 60,000 characters. Oversized context fails before any provider call. These are character budgets rather than an exact tokenizer-based cost estimate.

## Server and conversation flow

The web application now connects this package to authenticated routes:

- `GET /api/agent/status` reports configuration and the current account without exposing credentials.
- `GET /api/agent/history?platform=kalshi&id=...` returns the latest ten owned runs for the exact market, in chronological order.
- `POST /api/agent/messages` accepts only platform, nativeId, provider, message and a UUID requestId. The server loads identity, market data, saved pick and conversation context itself.

Every run reads the current saved pick, even if the model omits that tool from its plan. The planner may also request approved preferences and a saved snapshot comparison. Tools cannot fetch arbitrary URLs or mutate records. The response includes a read trace, supplied source references, referenced preferences and an optional pick draft. Market terms and prices are available evidence; independent news search is not implemented.

Runs are persisted in PostgreSQL through migration `0004_vengeful_ben_grimm.sql`. Request receipts replay the stored result rather than generating twice. Changed payloads with the same receipt are rejected. A conversation permits one active run; the account limit is thirty new runs per hour. Runs older than two minutes are marked failed on a subsequent send. No database transaction is held open during model calls. History uses at most sixteen messages within a 30,000-character budget, dropping the oldest complete exchanges first.

Every analysis turn checks preferences. When Walrus is configured, the official MemWal adapter recalls records in the user's namespace. After recall, current account records are reloaded; recalled lesson content must match that owned version before the scope/approval policy admits it. With no Walrus configuration, the response explicitly identifies account-only preferences. Recall failures fail the run rather than pretending that remote memory was read. The V10 memory-write worker is documented separately in memory-worker.md.

The chat panel loads history, sends messages, preserves failed drafts and reuses retry receipts. It shows sources, used preferences and optional read details. New pick drafts open the existing review form; changes to a saved pick require a separate review and explicit confirmation through the version-checked proposal API. Sending a chat message never applies a change. The composer is locked during a request, and account identity is checked before sending and before displaying the returned result.

## Verification and remaining work

25 October 2026: 126 unit tests and six offline integration tests pass, as do TypeScript, ESLint and the production build. Seven PostgreSQL integration tests are skipped without `TEST_DATABASE_URL`; the migration has not been applied to a live database. Authentication, model generation and Walrus/Mainnet recall still require this project's credentials and an end-to-end run. Browser interaction acceptance is pending because browser automation is disabled in Work settings.

V10 supersedes the verification status above: 141 unit and 18 real PostgreSQL integration tests pass; migrations are applied to separate local app/test databases. Structured model generation and one labelled MemWal write/exact-readback/fresh-client reuse passed. The owner authorized reusing game provider configuration. Google callback registration remains necessary for the authenticated browser journey.

The endpoint currently returns one completed JSON response. Resumable SSE, server cancellation, background monitoring, independent news ingestion and proactive suggestions remain pending. Memory now uses authenticated lesson routes and explicit reviewed controls, with the durable outbox worker documented in memory-worker.md. The weekly page counts real persisted activity. GetAgent public client behavior informed the design; its private backend and prompts were not inspected or copied.
