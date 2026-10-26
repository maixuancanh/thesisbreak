# Memory recovery and audit

GET /api/memory/recovery authenticates the owner and returns counts from their consented immutable outbox records, joined to owned memory receipts. POST requires the same authenticated owner, mutation origin checks, a body of at most 16 KiB, and exactly {"confirmed":true}. Owner IDs in the body are rejected. Responses omit lesson text, owner IDs, blob IDs and transport errors.

Restore calls MemwalAdapter.restore(expectedInventory), rebuilding the remote index then verifying every expected envelope. It does not delete any database or write any lesson, approval, status, version or receipt. Paused and retired database lessons remain paused and retired even if historical active versions exist remotely. The restore operation is a remote index mutation requiring explicit confirmation.

Local audit completeness is local_inventory_only. Verified distinct lesson counts deduplicate logical lesson IDs across versions and require exact canonical envelope hash, matching verified outbox result and memory receipt, and the same durable blob reference. These are database receipt evidence, not a fresh mainnet proof. Never pad a target with synthetic lessons. Pending/malformed records remain visible as rejected records; inventories over 500 records are marked truncated and restore is refused. Remote restore may report incomplete or unknown; only expected_inventory_verified means the supplied inventory was found, not that all remote history is known.

Run `node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs scripts/audit-mainnet.ts` for a read-only database receipt audit. It outputs aggregate counts only and does not call the network. Its name does not establish mainnet or fresh chain evidence.

`evals/memory-policy.ts` contains 24 fixed labelled heldout applicability cases. The no-memory baseline always declines lessons. The scoped structured policy tests ownership, scope, approval, pause/retirement, supersession, effective windows and malformed inputs. Results measure deterministic filtering, not LLM answer quality or a production quality lift.

UI integration: import MemoryRecovery from apps/web/components/memory-recovery.tsx and render it on the existing memory page. Real DB integration tests use only TEST_DATABASE_URL and UUID-owned fixtures; they never invoke live Walrus operations.
