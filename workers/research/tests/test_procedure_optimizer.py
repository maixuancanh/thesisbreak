import copy
import pytest
from thesisbreak_research.cli import dispatch, Request
from thesisbreak_research.procedure_optimizer import candidate_hash


def payload():
    seed = {"researchInstructions": "Read the official injury report before researching quotes."}
    return dict(seed=seed, reviewerId="reviewer", requestedBy="owner", optimizerConsent=True,
                corpusVersion="synthetic-v1", mode="synthetic", cases=[dict(
                    id="case1", split="development", optimizerConsent=True,
                    candidateHash=candidate_hash(seed), expectedActions=["read_report"],
                    allowedEvidenceIds=["report"], requiredEvidenceIds=["report"],
                    trace=dict(actions=["read_report"], evidenceIds=["report"], violations=[],
                               output="Checked official report", error=None, modelCalls=1,
                               outputTokens=20, latencyMs=10., costUsd=0.))],
                maxCalls=2, maxOutputTokens=100)


def run(p):
    return dispatch(Request(operation="procedure_evaluate", payload=p))


def test_cli_scores_actual_trace_with_no_invented_gain_or_promotion():
    report = run(payload())
    assert report["scores"] == [1.]
    assert report["metrics"]["grounding"] == 1.
    assert report["metrics"]["action"] == 1.
    assert report["evaluationScope"] == "recorded_trace"
    assert report["validationPassed"] is False
    assert report["sealedTestPassed"] is False
    assert report["benefitDemonstrated"] is False
    assert report["raw"][0]["result"]["output"] == "Checked official report"


def test_failures_and_unknown_evidence_are_retained_and_critical():
    p=payload()
    p["cases"][0]["trace"].update(evidenceIds=["foreign"], error="runtime_failed")
    report=run(p)
    assert report["scores"] == [0.]
    assert report["raw"][0]["result"]["error"] == "runtime_failed"
    assert "UNKNOWN_EVIDENCE" in report["criticalViolations"]


@pytest.mark.parametrize("patch", [
    {"reviewerId":"owner"}, {"optimizerConsent":False}, {"maxCalls":0},
    {"seed":{"confirmation":"skip"}}, {"unexpected":1},
])
def test_rejects_missing_authority_policy_mutation_and_budget(patch):
    p=payload(); p.update(patch)
    with pytest.raises(ValueError): run(p)


def test_holdout_and_mismatched_candidate_are_never_optimizer_training():
    for field,value in [("split","sealed"),("candidateHash","a"*64),("optimizerConsent",False)]:
        p=payload(); p["cases"][0][field]=value
        with pytest.raises(ValueError): run(p)
    p=payload(); p["cases"].append(copy.deepcopy(p["cases"][0]))
    with pytest.raises(ValueError): run(p)


def test_scores_measure_compliance_without_granting_success_for_empty_trace():
    p=payload(); p["cases"][0]["trace"].update(actions=[], evidenceIds=[])
    report=run(p)
    assert report["scores"] == [0.]
    assert report["metrics"]["grounding"] == 0.


def test_actual_gepa_uses_deterministic_tool_environment_and_keeps_baseline_on_failures():
    from thesisbreak_research.procedure_optimizer import optimize_action_replay
    p=dict(seed={"proposedReadOrder":'["read_quote"]'},
           proposals=[{"proposedReadOrder":'["read_report"]'}],
           reviewerId="reviewer",requestedBy="owner",optimizerConsent=True,
           corpusVersion="synthetic-v1",mode="synthetic",maxCandidates=2,
           cases=[dict(id="case1",split="development",optimizerConsent=True,
                       expectedActions=["read_report"],allowedEvidenceIds=["report"],
                       requiredEvidenceIds=["report"],tools={"read_report":["report"],"read_quote":[]})])
    result=optimize_action_replay(p)
    assert result["method"] == "gepa.action_replay"
    assert result["selectedCandidate"] == p["proposals"][0]
    assert result["raw"]
    assert result["benefitDemonstrated"] is False
    assert result["sealedTestPassed"] is False
    p["proposals"]=[{"proposedReadOrder":'["read_forbidden"]'}]
    result=optimize_action_replay(p)
    assert result["selectedCandidate"] == p["seed"]
    assert any('UNKNOWN_TOOL' in r['result']['violations'] for r in result['raw'])


def test_callback_cannot_exceed_case_budget_and_failed_attempt_is_retained():
    from thesisbreak_research.procedure_optimizer import ProcedureAdapter
    from thesisbreak_research.forecasting import Budget
    sent=[]
    def evaluator(candidate,case,budget):
        budget.reserve(3,1)
        sent.append('network would happen here')
    adapter=ProcedureAdapter(evaluator,Budget(20,100))
    result=adapter.evaluate([dict(id='case',split='development',optimizerConsent=True)],
                            {'researchInstructions':'check'},True)
    assert sent == []
    assert result.scores == [0.]
    assert adapter.raw[0]['result']['error'] == 'CASE_CALL_LIMIT'


def test_cli_gepa_response_is_clean_json_and_bounded_three_candidates():
    import json
    import os
    import subprocess
    import sys
    p=dict(seed={'proposedReadOrder':'["quote"]'},
           proposals=[{'proposedReadOrder':'["missing"]'},{'proposedReadOrder':'["report"]'}],
           reviewerId='reviewer',requestedBy='owner',optimizerConsent=True,
           corpusVersion='synthetic-v1',mode='synthetic',maxCandidates=3,
           cases=[dict(id='case',split='development',optimizerConsent=True,
                       expectedActions=['report'],allowedEvidenceIds=['e'],requiredEvidenceIds=['e'],
                       tools={'quote':[],'report':['e']})])
    response=subprocess.run([sys.executable,'-m','thesisbreak_research.cli'],
        input=json.dumps(dict(operation='procedure_optimize',payload=p)),text=True,
        capture_output=True,timeout=15,env=dict(os.environ,PYTHONPATH='src'))
    assert response.returncode == 0
    report=json.loads(response.stdout)['result']
    assert report['method']=='gepa.action_replay'
    assert len(report['candidates'])<=3
    assert report['metricCalls']<=9
    assert report['selectedCandidate']==p['proposals'][1]
    assert report['usage']['modelCalls']==0
