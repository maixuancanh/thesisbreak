# Memory outbox worker

Launch from the project root:

```powershell
pnpm exec tsx scripts/memory-worker.ts --enable-remote-writes --once
# Omit --once for polling.
```

Requires DATABASE_URL and the existing validated MEMWAL_DELEGATE_KEY, MEMWAL_ACCOUNT_ID, optional MEMWAL_RELAYER_URL. The explicit launch flag enables real remote writes. Do not run against Mainnet to verify local implementation.

Only lesson.version.created events with JSON boolean memoryConsent:true are eligible. Consent belongs to the exact version; approval alone is insufficient. Unconsented historical picks, watch plans and other event kinds remain untouched. The exact owned lesson version must still be current, approved, active and not superseded when claimed. Ineligible versions become blocked. Lifecycle changes update local authority; recall must continue consulting local authority to reject stale remote lessons.

A PostgreSQL transaction claims one row using FOR UPDATE SKIP LOCKED. Each claim increments attempts, which serves as a fencing token, with a 120 second lease. Completion requires the matching owner, operation key, attempt and an unexpired lease. Expired work is reclaimable. SDK writes have a 95 second orchestration timeout. A timed out network request may still complete remotely; retry uses the same logical ID, timestamp and bytes so the adapter's deterministic idempotency key remains stable. Persistence is at least once; no exactly once network guarantee is asserted.

The memory_records database logical_id is the outbox operation key (one row per version); the remote envelope logicalId is lessonId, paired with version for recall authorization. recordedAt is immutable outbox.created_at. The immutable materialized record is retained in outbox.outcome across retries; any changed reconstruction fails closed. Only the adapter's verified result (which requires exact readback) marks memory_records verified and outbox done. Pending reads and transport failures retry with exponential delay capped at one hour. Retries do not have a terminal attempt limit. Operators should inspect repeated failures and blocked rows. No secrets or payloads are logged by the CLI.

Exports: lessonRowToPayload, claimMemoryOutbox(pool, leaseMs?), finishMemoryOutbox(pool, claim, result); MemoryClaim and LessonRow types. Pure orchestration: processMemoryClaim(claim, adapter, timeoutMs?) with MemoryWriter and MemorySyncResult types. The mapper omits null optional reviewAt/originatingCorrection fields and validates lessonVersionSchema.

Verification:

```powershell
pnpm exec vitest run tests/unit/memory-sync.test.ts tests/integration/memory-outbox-database.test.ts
pnpm exec tsc --noEmit
```

Database integration requires TEST_DATABASE_URL pointing to an isolated migrated database. Fixtures use random owners and remove only their own rows. Without that variable the database test skips. Tests never contact MemWal. This implementation does not prove authenticated MemWal or Mainnet availability.

`claimMemoryOutbox` drains up to 100 stale or malformed consented events per call. Blocked events do not report an empty queue; exceeding this bound throws `MEMORY_OUTBOX_SKIP_BUDGET_EXCEEDED` so operators can rerun after inspecting the backlog. Invalid lesson IDs or versions are blocked before version SQL queries.
