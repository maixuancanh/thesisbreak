"""JSONL GEPA RPC bridge. Provider credentials stay in the parent Node process."""
import contextlib
import json
import sys
from .forecasting import Budget
from .procedure_optimizer import ProcedureAdapter, optimize, candidate_hash


def send(value):
    sys.__stdout__.write(json.dumps(value, allow_nan=False, separators=(',', ':'))+'\n')
    sys.__stdout__.flush()


def receive():
    line=sys.stdin.buffer.readline(4_000_001)
    if len(line)>4_000_000 or not line: raise ValueError('RPC_INPUT_LIMIT')
    return json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))


def main():
    adapter=None
    try:
        request=receive()
        if set(request)!={'seed','cases','maxCandidates','maxCalls','maxOutputTokens','deadlineSeconds'}: raise ValueError('INVALID_RPC_REQUEST')
        if not 0<=request['maxCalls']<=62 or not 0<=request['maxOutputTokens']<=240000 or not 1<=request['deadlineSeconds']<=3600: raise ValueError('RPC_BUDGET_LIMIT')
        budget=Budget(request['maxCalls'],request['maxOutputTokens'],request['deadlineSeconds'])
        def rpc(kind,**data):
            send(dict(type=kind,**data))
            response=receive()
            if set(response)!={'ok','result'} or response['ok'] is not True: raise ValueError('RUNTIME_CALLBACK_FAILED')
            return response['result']
        def evaluator(candidate,case,case_budget):
            case_budget.reserve(2,3800)
            return rpc('evaluate',candidate=candidate,caseId=case['id'])
        def proposer(candidate,dataset,components):
            budget.reserve(1,1000)
            return rpc('propose',candidate=candidate,feedback=dataset,components=components)
        adapter=ProcedureAdapter(evaluator,budget,proposer)
        with contextlib.redirect_stdout(sys.stderr):
            result=optimize(request['seed'],request['cases'],adapter,request['maxCandidates'])
        selected=result.best_candidate
        if any(t['criticalViolation'] for t in adapter.raw if t['candidateHash']==candidate_hash(selected)):
            selected=request['seed']
        send(dict(type='result',result=dict(method='gepa.read_only_agent_runtime',
                  selectedCandidate=selected,candidates=result.candidates,
                  developmentScores=result.val_aggregate_scores,raw=adapter.raw,
                  reservedModelCalls=budget.calls,reservedOutputTokens=budget.tokens,
                  validationPassed=False,sealedTestPassed=False,benefitDemonstrated=False,
                  productionMutations=0,costUsd=None,costMeasurement='unavailable')))
        return 0
    except Exception:
        send(dict(type='failure',result=dict(code='RUNTIME_OPTIMIZER_FAILED',raw=adapter.raw if adapter else [])))
        return 1


if __name__=='__main__': sys.exit(main())
