import json
import math
from datetime import datetime, timezone

import pytest

from thesisbreak_research.contracts import ResearchEnvelope, ComponentForecast, validate_components
from thesisbreak_research.forecasting import ensemble, Budget
from thesisbreak_research.calibration import diagnostics, validate_split, cluster_bootstrap
from thesisbreak_research.online_learning import rebuild
from thesisbreak_research.procedure_optimizer import validate_candidate, ProcedureAdapter


def envelope():
    return dict(schemaVersion=1, jobId="j", namespace="eval", mode="synthetic", ownerId="o", eventId="e", marketId="m", outcomeId="yes", cutoffAt="2026-10-01T00:00:00Z", eventStartAt="2026-10-02T00:00:00Z", evidence=[dict(id="e1",sha256="a"*64,originId="origin",url="https://example.com/a",observedAt="2026-09-30T00:00:00Z",publishedAt=None,availableAt="2026-09-30T00:00:00Z",eventId="e")], modelVersion="m1", procedureVersion="p1", maxCalls=3, maxOutputTokens=1000)


def component(p=.2, **kw):
    return dict(componentId="c", probability=p, status="ok", evidenceIds=[], originIds=[], assumptions=[], failureCode=None, **kw)


def test_contract_strict_and_times():
    assert ResearchEnvelope.model_validate(envelope()).ownerId == "o"
    for patch in [{"surprise": 1}, {"maxCalls": True}, {"cutoffAt": "2026-10-03T00:00:00Z"}, {"cutoffAt": "2026-10-01"}]:
        with pytest.raises(ValueError):
            ResearchEnvelope.model_validate(envelope() | patch)
    for p in [math.nan, math.inf, -.1, 1.1]:
        with pytest.raises(ValueError): ComponentForecast.model_validate(component(p))
    with pytest.raises(ValueError): validate_components(ResearchEnvelope.model_validate(envelope()), [ComponentForecast.model_validate(component() | {"evidenceIds": ["unknown"]})])


def test_ensemble_failure_and_budget():
    rows = [ComponentForecast.model_validate(component(p) | {"componentId": str(i)}) for i,p in enumerate([.2,.6,.7])]
    assert ensemble(rows)["probability"] == .6
    assert ensemble(rows[:1])["status"] == "unavailable"
    budget = Budget(1, 100)
    budget.reserve(1, 100)
    with pytest.raises(ValueError): budget.reserve(1, 1)


def test_diagnostics_and_leakage():
    report = diagnostics([0.,1.], [0,1], bins=4)
    assert report["brier"] == 0
    assert report["bins"][1]["meanProbability"] is None
    assert math.isfinite(report["logLoss"])
    with pytest.raises(ValueError): validate_split([{"eventId":"a","availableAt":"2026-01-02T00:00:00Z"}], [{"eventId":"a","availableAt":"2026-01-03T00:00:00Z"}], "2026-01-02T00:00:00Z")
    ci = cluster_bootstrap([{"eventId":"a","baseline":.1,"challenger":.05},{"eventId":"b","baseline":.3,"challenger":.2}], repeats=100)
    assert ci["delta"] < 0 and ci["clusters"] == 2


def row(version=1, label=1, at="2026-01-02T00:00:00Z"):
    return dict(forecastId="f",eventId="e",outcomeVersion=version,challengerVersion="v1",probability=.8,label=label,availableAt=at,cutoffAt="2026-01-01T00:00:00Z",league="test",marketType="binary",horizon="24h",primary=True)


def test_river_delayed_duplicates_and_correction():
    empty = rebuild([row()], "2026-01-01T12:00:00Z")
    assert empty["samples"] == 0
    one = rebuild([row(),row()], "2026-01-03T00:00:00Z")
    corrected = rebuild([row(),row(2,0,"2026-01-03T00:00:00Z")], "2026-01-04T00:00:00Z")
    assert one["samples"] == corrected["samples"] == 1
    assert one["brier"] < corrected["brier"]
    assert corrected["revisions"] == 1
    assert corrected == rebuild([row(2,0,"2026-01-03T00:00:00Z"),row()], "2026-01-04T00:00:00Z")


def test_optimizer_permissions_and_real_gepa_batch():
    with pytest.raises(ValueError): validate_candidate({"confirmation":"optional"})
    calls=[]
    def evaluate(candidate, case, budget):
        calls.append(case)
        budget.reserve(1,10)
        return {"grounding":1.,"action":1.,"latency":.1,"cost":.01,"violations":[],"output":"ok"}
    adapter = ProcedureAdapter(evaluate, Budget(2,20))
    batch=adapter.evaluate([{"id":"a","split":"development","optimizerConsent":True}], {"researchInstructions":"check evidence"}, True)
    assert batch.scores == [1.]
    with pytest.raises(ValueError): adapter.evaluate([{"id":"b","split":"sealed","optimizerConsent":True}], {"researchInstructions":"x"}, True)
