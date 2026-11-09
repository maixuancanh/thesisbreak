# Database foundation

PostgreSQL is the authority for ownership and mutable lifecycle state. The schema and generated migrations use the official Drizzle PostgreSQL tooling and node-postgres driver. Domain policies use Zod. No database is embedded or silently substituted.

Use Node 24 and the pinned pnpm version from the workspace package.json. From the project root:

```powershell
pnpm install --frozen-lockfile
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@localhost:5432/thesisbreak_dev'
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test:unit
```

For integration tests, provision a separate empty PostgreSQL database. Apply the same migrations to that database, then run:

```powershell
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@localhost:5432/thesisbreak_test'
pnpm db:migrate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm test:integration
```

These are example connection strings, not supplied credentials. Without TEST_DATABASE_URL, the concurrency integration test is explicitly skipped; without DATABASE_URL the migration command exits with BLOCKED. Migration generation does not prove migration execution.

`commitPickVersion` is a trusted-server transaction primitive. An authenticated confirmation endpoint must validate ownership, proposal state, expiry and consent before calling it. It validates changes, serializes concurrent mutations with PostgreSQL locks, checks baseVersion, writes an immutable version and its outbox operation atomically, and records an idempotency result scoped to user plus request ID. Reusing the same request ID with a different payload returns conflict. It does not implement proposal confirmation, provider delivery, or notifications.

The current version pointers for picks, plans and lessons are authority rows. Versions include ancestry checks and self foreign keys; user composite foreign keys prevent attaching a version to another user's entity. Application repositories remain responsible for authorized state transitions. JSON trace references are audit payloads, not a replacement for ownership checks when reading their referenced entities.

No PostgreSQL service or credential was available during scaffolding: migration execution and the concurrent request test remain unverified. Web has a pinned Next.js/React manifest; routes and worker commands are added only when implementations exist.

Plan and lesson updates use commitWatchPlanVersion and commitLessonVersion. Both accept the complete reviewed next version, validate the domain schema, lock the entity and user/request idempotency key, reject a stale baseVersion with 409, and atomically write the version, authority pointer, replay result, and outbox. The plan primitive checks its owning pick; the database independently enforces plan/owner/pick association through one composite foreign key. These APIs do not replace authenticated user confirmation. Their PostgreSQL concurrency tests remain gated on TEST_DATABASE_URL.
