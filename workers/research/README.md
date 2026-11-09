# THESISBREAK isolated research worker

Run from this directory with Python 3.12 (the available supported local runtime):

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -e '.[research,test]'
.venv/Scripts/python -m pytest tests -q
$env:PYTHONPATH='src'
'{"operation":"capabilities","payload":{}}' | .venv/Scripts/python -m thesisbreak_research.cli
```

The CLI accepts one JSON document, maximum 4 MB, and returns one JSON response.
It has no credentials, database URL, wallet, publish endpoint, or pick mutation
interface. Contract errors are redacted. The owner, namespace and job identity
must be supplied by the trusted queue and compared against the claimed lease by
the Node bridge; schema validation alone does not authenticate an owner.

Operations: `validate_contract` takes an envelope directly; `forecast` takes
`{envelope, components}` and validates frozen evidence references; `calibration`
takes `{probabilities, labels, bins?}`; `online_learning` takes `{rows, asOf}`;
`capabilities` reports installed package versions. `procedure_evaluate` scores
explicitly consented observed execution traces bound to the candidate hash,
corpus version and separate reviewer identity. Scores are computed from action
and evidence sets against explicit labels; callers cannot supply scalar scores.
It retains failed traces, actual reported latency/cost and usage. It validates
development data only and never grants validation, sealed-test or promotion.
The trusted queue checks requested owner, mode and evaluation namespace. Identity
fields on a CLI request are metadata, not authentication or reviewer approval.

Actual package paths used: forecasting-tools `BinaryReport.aggregate_predictions`
and `LogisticRecalibrationAdjuster`; netcal `ECE`, `BetaCalibration` and
`IsotonicRegression`; River metrics, pipeline logistic learner and native ADWIN;
GEPA `EvaluationBatch` and `optimize`. Installation does not configure a paid
provider. The forecast CLI aggregates structured estimates supplied by the
trusted caller; it does not claim those estimates were independently researched.
The Python `run_components` API supports explicit async provider callbacks with
frozen envelopes, pre-reservation, shared call/token budget and timeouts.

Calibration requires at least 100 distinct settled training events and 20 per
class. Chronological split validation excludes event overlap and future labels.
Bootstrap uses event clusters, retaining all horizons in a cluster. These are
operational thresholds, not statistical proof. Sealed selection and prospective
cohort registration belong to the application protocol, outside this CLI.

River rebuilds canonical revisions deterministically instead of loading unsafe
pickled state. Corrections replace the affected canonical sample and rebuild
all derived models/metrics; old forecast artifacts remain immutable in the
ledger. `inputPrefixHash` makes restart comparisons reproducible. Stream keys
include league/market/horizon/version, and drift needs 100 primary events.
The trajectory logs predictions before learning. No drift result changes user
authority. The caller must stop owner synchronization when consent is paused.

GEPA only mutates research instructions, query templates and proposed read order.
Its real evaluator/proposer callbacks must reserve every model and tool call;
development data requires separate optimizer consent. Forbidden policy fields
and sealed cases are rejected, critical violations receive zero score and are
retained in raw trajectories. Production promotion, reviewer identity, sealed
test once-only access and rollback remain Node ledger responsibilities.

`procedure_optimize` is a runnable, network-free GEPA evaluator. It executes
preauthorized read-order candidates against a deterministic local tool map,
then uses actual `gepa.optimize` selection and Pareto objectives. The evaluator
supports `proposedReadOrder` containing a JSON array of tool IDs. It does not
interpret natural-language instructions; those need an explicitly supplied real
runtime evaluator through the Python `ProcedureAdapter` and `optimize` APIs.
At most three candidates and ten development cases are accepted. Per-case
reservations reject a third model call before IO. Reflection proposals supplied
in this mode consume zero model requests. Raw failed attempts remain in reports.
This local environment measures tool/evidence compliance only; positive scores
do not establish forecasting benefit or live-model quality. No provider is
configured by either CLI operation. Example:

```json
{"operation":"procedure_optimize","payload":{"seed":{"proposedReadOrder":"[\"quote\"]"},"proposals":[{"proposedReadOrder":"[\"report\"]"}],"reviewerId":"reviewer","requestedBy":"evaluation-owner","optimizerConsent":true,"corpusVersion":"self-authored-synthetic-v1","mode":"synthetic","maxCandidates":2,"cases":[{"id":"injury-check","split":"development","optimizerConsent":true,"expectedActions":["report"],"allowedEvidenceIds":["official-report"],"requiredEvidenceIds":["official-report"],"tools":{"quote":[],"report":["official-report"]}}]}}
```

Save this request as `request.json`, then from the worker directory run:

```powershell
$env:PYTHONPATH='src'
Get-Content -Raw request.json | .venv/Scripts/python -m thesisbreak_research.cli
```

The report labels development scores, retains trajectories, and always returns
`validationPassed=false`, `sealedTestPassed=false`, `benefitDemonstrated=false`.
`baselineUnchanged=true` means the active production procedure was not changed.
Recorded trace hashes use UTF-8, sorted candidate keys and compact JSON; the Node
helper `optimizerCandidateHash` implements the same hash. Historical environment
artifacts must already exclude future evidence; synthetic mode is for tests.

Local adapter tests use synthetic data and make no live model requests. Hosted
verification, authenticated application flows and measured benefit are separate
acceptance gates. No worker is deployed or enabled by installing this package.
