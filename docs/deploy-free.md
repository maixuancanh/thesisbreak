# Free-tier deployment

The owner selected free hosting on 26 October. Do not apply `deploy/render-paid.example.yaml`; it is a separate paid alternative. No paid resources have been created by preparing these files.

## Services

- Vercel: Next.js web and authenticated request handlers, project root `apps/web`, Node 24, workspace package tracing enabled. Keep populated environment files and `.local` out of upload.
- Neon Free: dedicated PostgreSQL database, pooled TLS connection for requests. Apply migrations through a controlled operator command before allowing account writes. Do not migrate the game's database or automatically copy local demo accounts.
- Scheduled worker batches: `.github/workflows/workers.yml` is disabled unless repository variable `WORKERS_ENABLED=true`. It runs at minutes 7, 22, 37 and 52, processing at most three consented memory jobs and five market checks per run. Empty queues finish early, errors fail visibly, and existing database lease/idempotency checks remain in force. Schedules can be delayed. This is not continuous real-time monitoring. A public repository, production environment secrets and owner-approved remote-write configuration are required before enabling it.
- Model endpoint: a separately configured authenticated HTTPS service. The authenticated gateway is deployed on Render Free in Singapore. Missing-key model requests and unauthenticated admin settings return HTTP401. The loopback model endpoint is not usable from Vercel. Render sleeps on idle and loses local filesystem changes, so provider refresh credentials must not depend on an unbacked ephemeral SQLite file. Do not bypass authentication or add artificial keep-alive traffic to avoid free-tier restrictions.

## Configuration and checks

27 October progress: Neon connection and migrations succeeded (26 public tables, nine migration records). Vercel has production account and memory settings. Google sign-in completed in-browser, confirmed by a Google identity and active session in Neon. The GitHub worker production secrets are configured, WORKERS_ENABLED is true, and manual/scheduled batches have completed. The Render model endpoint and Vercel model settings are now deployed. A Google-authenticated browser conversation about a real Kalshi NBA condition completed with market and official-team-news citations. Health returns ready. No new production memory write is established by these checks.

Use `.env.example` as the list of server variables. Vercel needs app/database/OAuth/model/Walrus configuration, while scheduled jobs receive only database and their relevant provider settings. GitHub secrets must never be included in workflow source. Check current free quotas before enabling a frequent schedule; private repositories have different allowances. The public source repository and bounded scheduled worker are active; empty successful batches do not prove a remote write.

The production database setting is kept privately in `.local/production-database.env`. Verify the target is the dedicated empty Neon database before migrating. Keep local `.env` pointed at the local database. A build without credentials can verify rendering and signed-out blocked behavior, but must not be presented as a working authenticated production release.

Before enabling the first production memory write, confirm Google callback, exact account namespace, reviewed consent, queue status and remote readback. Show pending status while waiting for the next batch. On a model cold start, return an honest unavailable/retry state rather than a fabricated answer. Inspect logs and retry only through existing idempotent operations.

References: [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Render Free limits](https://render.com/docs/free), [Neon pooled connection URI](https://api-docs.neon.tech/reference/getconnectionuri).
