# Deployment and submission gates

26 October update: owner selected free hosting. See [free deployment](deploy-free.md). Initial web build is deployed at https://thesisbreak.vercel.app and source is public at https://github.com/maixuancanh/thesisbreak. The deployed account/model/database configuration is not ready: health returns503 and account mutations fail closed. This does not establish the hosted memory journey. No paid Render services were activated.

The web production build passes locally. Dockerfiles prepare separate web and worker services; the images have not been built or deployed in this run. `.dockerignore` excludes local provider runtime, credentials, PostgreSQL data and generated caches. Deploying a container is a separate verification step.

Use managed PostgreSQL for production and apply migrations before traffic. Run separate memory and market-source worker services, each with the same database and server configuration as the web app. Set WORKER_KIND=memory or markets for Dockerfile.worker. Back up account authority and immutable memory inventory; Walrus index restoration does not replace a database backup or restore lost permissions.

The current local LLM gateway listens on loopback and is allowed only in development. Production needs an authenticated HTTPS provider endpoint. Do not disable URL validation, use a public unauthenticated tunnel or publish the local gateway credentials. APP_URL must be the deployed HTTPS origin; add that exact origin's /api/auth/callback/google to the existing Google OAuth client without removing the game's callbacks. Use the dedicated THESISBREAK session secret and database.

Before publishing:

- Verify health, worker heartbeat/restart, database restore and one provider outage on the deployed infrastructure.
- Run sign-in → reviewed pick → chat → reviewed lesson → verified Walrus receipt → new event → remembered preference → pause → exclusion → explicit resume → new version sync.
- Test status SSE reconnect and cancellation on the deployed request duration limits. This implementation streams durable status, not tokens, and does not resume execution after a generation process crash.
- Configure Tatum Sui Mainnet RPC and expected account owner. Preserve proof timestamps and provenance; successful object observation does not establish user control of the owner wallet.
- Audit at least ten distinct useful, consented memories with actual receipts. Do not manufacture preferences, count retries or present labelled tests as real users.
- Verify independent news/event mapping before claiming lineup or assumption-change monitoring. Native market updates alone do not establish those facts.
- Prepare a public source allowlist, third-party notices, README, a sourced blog draft and a demo showing real memory reuse. Check all live URLs and current contest submission fields before submitting.

Public independent-source retrieval and scoped NBA status watches are now locally verified; see independent-sources.md. No hosted release, ten-memory requirement, broad news/event coverage, LLM quality lift, public repository or final submission is established by the current local tests.
