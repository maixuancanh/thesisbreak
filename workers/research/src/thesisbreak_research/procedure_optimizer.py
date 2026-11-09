"""GEPA adapter with external authority and explicitly authorized evaluators."""
import hashlib
import json
import math
from typing import Annotated, Literal
from pydantic import Field, model_validator
from .contracts import StrictModel, Id, Hash
from .forecasting import Budget

ALLOWED={'researchInstructions','queryTemplates','proposedReadOrder'}


def candidate_hash(candidate):
    validate_candidate(candidate)
    return hashlib.sha256(json.dumps(candidate,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Count = Annotated[int, Field(ge=0)]


class ExecutionTrace(StrictModel):
    actions: list[Id] = Field(max_length=100)
    evidenceIds: list[Id] = Field(max_length=100)
    violations: list[Id] = Field(max_length=100)
    output: str = Field(max_length=16000)
    error: str | None = Field(max_length=1000)
    modelCalls: Count = Field(le=2)
    outputTokens: Count
    latencyMs: Nonnegative
    costUsd: Nonnegative


class EvaluationCase(StrictModel):
    id: Id
    split: Literal['development']
    optimizerConsent: Literal[True]
    candidateHash: Hash
    expectedActions: list[Id] = Field(min_length=1,max_length=100)
    allowedEvidenceIds: list[Id] = Field(min_length=1,max_length=100)
    requiredEvidenceIds: list[Id] = Field(min_length=1,max_length=100)
    trace: ExecutionTrace


class EvaluationRequest(StrictModel):
    seed: dict[str,str]
    reviewerId: Id
    requestedBy: Id
    optimizerConsent: Literal[True]
    corpusVersion: Id
    mode: Literal['synthetic','historical_replay','prospective']
    cases: list[EvaluationCase] = Field(min_length=1,max_length=10)
    maxCalls: Count = Field(le=60)
    maxOutputTokens: Count = Field(le=1000000)

    @model_validator(mode='after')
    def authority_and_provenance(self):
        validate_candidate(self.seed)
        if self.reviewerId == self.requestedBy: raise ValueError('INDEPENDENT_REVIEWER_REQUIRED')
        if len({c.id for c in self.cases}) != len(self.cases): raise ValueError('DUPLICATE_CASE')
        if sum(c.trace.modelCalls for c in self.cases)>self.maxCalls or sum(c.trace.outputTokens for c in self.cases)>self.maxOutputTokens: raise ValueError('BUDGET_EXCEEDED')
        for c in self.cases:
            if c.candidateHash != candidate_hash(self.seed): raise ValueError('CANDIDATE_TRACE_MISMATCH')
            if not set(c.requiredEvidenceIds)<=set(c.allowedEvidenceIds): raise ValueError('INVALID_GOLD_EVIDENCE')
        return self


def score_trace(trace, expected_actions, allowed_evidence, required_evidence):
    """Score observed execution against explicit corpus labels, never supplied scores."""
    actions=set(trace['actions']); expected=set(expected_actions)
    evidence=set(trace['evidenceIds']); required=set(required_evidence)
    violations=list(trace['violations'])
    if evidence-set(allowed_evidence): violations.append('UNKNOWN_EVIDENCE')
    if actions-expected: violations.append('UNEXPECTED_ACTION')
    if trace['error'] is not None: violations.append('RUNTIME_FAILED')
    grounding=len(evidence & required)/len(evidence | required)
    action=len(actions & expected)/len(actions | expected)
    return dict(grounding=grounding,action=action,latency=trace['latencyMs'],cost=trace['costUsd'],
                violations=sorted(set(violations)),output=trace['output'],error=trace['error'],trace=trace)


def evaluate_recorded(payload):
    request=EvaluationRequest.model_validate(payload)
    budget=Budget(request.maxCalls,request.maxOutputTokens)
    def evaluator(candidate,case,budget):
        trace=case['trace']
        budget.reserve(trace['modelCalls'],trace['outputTokens'])
        return score_trace(trace,case['expectedActions'],case['allowedEvidenceIds'],case['requiredEvidenceIds'])
    adapter=ProcedureAdapter(evaluator,budget)
    batch=adapter.evaluate([c.model_dump() for c in request.cases],request.seed,True)
    return dict(evaluationScope='recorded_trace',candidateHash=candidate_hash(request.seed),
                corpusVersion=request.corpusVersion,mode=request.mode,scores=batch.scores,raw=adapter.raw,
                metrics={k:sum(t['result'][k] for t in adapter.raw)/len(adapter.raw) for k in ('grounding','action','latency','cost')},
                criticalViolations=sorted({v for t in adapter.raw for v in t['result']['violations']}),
                usage=dict(modelCalls=budget.calls,outputTokens=budget.tokens),
                validationPassed=False,sealedTestPassed=False,benefitDemonstrated=False,
                status='rejected' if any(t['criticalViolation'] for t in adapter.raw) else 'development_evaluated')


class ReplayCase(StrictModel):
    id: Id
    split: Literal['development']
    optimizerConsent: Literal[True]
    expectedActions: list[Id] = Field(min_length=1,max_length=100)
    allowedEvidenceIds: list[Id] = Field(min_length=1,max_length=100)
    requiredEvidenceIds: list[Id] = Field(min_length=1,max_length=100)
    tools: dict[Id,list[Id]]


class ReplayRequest(StrictModel):
    seed: dict[str,str]
    proposals: list[dict[str,str]] = Field(max_length=2)
    reviewerId: Id
    requestedBy: Id
    optimizerConsent: Literal[True]
    corpusVersion: Id
    mode: Literal['synthetic','historical_replay']
    maxCandidates: Annotated[int, Field(ge=1,le=3)]
    cases: list[ReplayCase] = Field(min_length=1,max_length=10)

    @model_validator(mode='after')
    def authority_and_caps(self):
        if self.reviewerId == self.requestedBy: raise ValueError('INDEPENDENT_REVIEWER_REQUIRED')
        if len(self.proposals)+1 != self.maxCandidates: raise ValueError('CANDIDATE_CAP_MISMATCH')
        if len({c.id for c in self.cases}) != len(self.cases): raise ValueError('DUPLICATE_CASE')
        for candidate in [self.seed,*self.proposals]:
            validate_candidate(candidate)
            if set(candidate)!={'proposedReadOrder'}: raise ValueError('ACTION_REPLAY_REQUIRES_EXPLICIT_READ_ORDER')
            actions=json.loads(candidate['proposedReadOrder'])
            if not isinstance(actions,list) or len(actions)>100 or any(not isinstance(a,str) or not a for a in actions): raise ValueError('INVALID_READ_ORDER')
        for c in self.cases:
            allowed=set(c.allowedEvidenceIds)
            if not set(c.requiredEvidenceIds)<=allowed or any(set(ids)-allowed for ids in c.tools.values()): raise ValueError('INVALID_GOLD_EVIDENCE')
        return self


def optimize_action_replay(payload):
    """Real GEPA search over pre-authorized read-order candidates in a local tool environment.

    This evaluator executes only the declared deterministic tool map. It cannot
    validate natural-language prompt changes or claim live research quality.
    No providers, credentials, side effects, model calls or fabricated costs.
    """
    import time
    request=ReplayRequest.model_validate(payload)
    proposals=iter(request.proposals)
    budget=Budget(0,0)
    def evaluator(candidate,case,budget):
        started=time.monotonic()
        actions=json.loads(candidate['proposedReadOrder'])
        evidence=[]; violations=[]
        for action in actions:
            if action not in case['tools']: violations.append('UNKNOWN_TOOL')
            else: evidence.extend(case['tools'][action])
        trace=dict(actions=actions,evidenceIds=evidence,violations=violations,
                   output=json.dumps(dict(actions=actions,evidenceIds=evidence)),error=None,
                   modelCalls=0,outputTokens=0,latencyMs=(time.monotonic()-started)*1000,costUsd=0.)
        return score_trace(trace,case['expectedActions'],case['allowedEvidenceIds'],case['requiredEvidenceIds'])
    def proposer(candidate,dataset,components):
        return next(proposals)
    adapter=ProcedureAdapter(evaluator,budget,proposer)
    cases=[c.model_dump() for c in request.cases]
    result=optimize(request.seed,cases,adapter,request.maxCandidates)
    # Critical failures are never selected solely because of an aggregate score.
    selected=result.best_candidate
    if any(t['criticalViolation'] for t in adapter.raw if t['candidateHash']==candidate_hash(selected)):
        selected=request.seed
    return dict(method='gepa.action_replay',evaluationScope='local_tool_environment',
                corpusVersion=request.corpusVersion,mode=request.mode,
                selectedCandidate=selected,selectedCandidateHash=candidate_hash(selected),
                candidates=result.candidates,developmentScores=result.val_aggregate_scores,
                metricCalls=result.total_metric_calls,raw=adapter.raw,
                usage=dict(modelCalls=0,outputTokens=0,costUsd=0.),
                validationPassed=False,sealedTestPassed=False,benefitDemonstrated=False,
                status='development_evaluated',baselineUnchanged=True)


def validate_candidate(candidate):
    if not candidate or set(candidate)-ALLOWED: raise ValueError('IMMUTABLE_POLICY_FIELD')
    if any(not isinstance(v,str) or not v.strip() or len(v)>16000 for v in candidate.values()): raise ValueError('INVALID_PROCEDURE')
    return candidate


class CaseBudget:
    """A preflight per-case cap sharing the parent request/token reservation."""
    def __init__(self, shared):
        self.shared=shared
        self.case_calls=0

    @property
    def calls(self): return self.shared.calls

    @property
    def tokens(self): return self.shared.tokens

    def reserve(self,calls,tokens):
        if self.case_calls+calls>2: raise ValueError('CASE_CALL_LIMIT')
        self.shared.reserve(calls,tokens)
        self.case_calls+=calls


class ProcedureAdapter:
    """An actual GEPA protocol adapter; never embeds a provider key or approver."""
    def __init__(self,evaluator,budget,proposer=None):
        self.evaluator=evaluator
        self.budget=budget
        self.proposer=proposer
        self.raw=[]
        self.proposal_count=0

    def evaluate(self,batch,candidate,capture_traces=False):
        from gepa.core.adapter import EvaluationBatch
        validate_candidate(candidate)
        if len(batch)>10: raise ValueError('CASE_LIMIT')
        outputs=[]; scores=[]; objectives=[]; traces=[]
        for case in batch:
            if case.get('split')!='development' or case.get('optimizerConsent') is not True: raise ValueError('OPTIMIZER_DATA_NOT_AUTHORIZED')
            # Callback owns real rollout and must reserve every model/tool call.
            import time
            started=time.monotonic()
            before_calls=self.budget.calls
            before_tokens=self.budget.tokens
            try:
                result=self.evaluator(dict(candidate),case,CaseBudget(self.budget))
                if any(not isinstance(result[k],(int,float)) or isinstance(result[k],bool) or not math.isfinite(result[k]) for k in ('grounding','action','latency','cost')): raise ValueError('NONFINITE_OBJECTIVE')
                if not 0<=result['grounding']<=1 or not 0<=result['action']<=1 or result['latency']<0 or result['cost']<0: raise ValueError('INVALID_OBJECTIVE')
            except Exception as error:
                # Preserve failed attempts without serializing provider exceptions,
                # which can include credentials or private request bodies.
                code=str(error) if isinstance(error,ValueError) and str(error) in {'CASE_CALL_LIMIT','BUDGET_EXCEEDED','NONFINITE_OBJECTIVE','INVALID_OBJECTIVE'} else 'EVALUATOR_FAILED'
                result=dict(grounding=0.,action=0.,latency=(time.monotonic()-started)*1000,cost=0.,costKnown=False,violations=[code],output=None,error=code)
            critical=bool(result['violations'])
            # GEPA maximizes objective scores: lower latency and cost are better.
            objective={k:result[k] * (-1 if k in ('latency','cost') else 1) for k in ('grounding','action','latency','cost')}
            trace=dict(caseId=case['id'],candidateHash=candidate_hash(candidate),result=result,criticalViolation=critical,
                       reservedCalls=self.budget.calls-before_calls,reservedOutputTokens=self.budget.tokens-before_tokens)
            self.raw.append(trace); traces.append(trace); outputs.append(result['output']); objectives.append(objective)
            scores.append(0. if critical else (result['grounding']+result['action'])/2)
        return EvaluationBatch(outputs=outputs,scores=scores,trajectories=traces if capture_traces else None,objective_scores=objectives)

    def make_reflective_dataset(self,candidate,eval_batch,components_to_update):
        if set(components_to_update)-ALLOWED: raise ValueError('IMMUTABLE_POLICY_FIELD')
        return {k:[{'Inputs':t['caseId'],'Generated Outputs':t['result']['output'],'Feedback':{'violations':t['result']['violations'],'grounding':t['result']['grounding'],'action':t['result']['action']}} for t in eval_batch.trajectories or []] for k in components_to_update}

    def propose_new_texts(self,candidate,reflective_dataset,components_to_update,**kwargs):
        if self.proposer is None: raise ValueError('NO_AUTHORIZED_PROPOSER')
        if set(components_to_update)-ALLOWED: raise ValueError('IMMUTABLE_POLICY_FIELD')
        # The proposer, like the evaluator, reserves its actual requests before IO.
        proposal=self.proposer(candidate,reflective_dataset,components_to_update)
        validate_candidate(proposal)
        self.proposal_count+=1
        return proposal


def optimize(seed,cases,adapter,max_candidates=3):
    import gepa
    validate_candidate(seed)
    if not 1<=max_candidates<=3 or len(cases)>10: raise ValueError('OPTIMIZER_CAP')
    if any(c.get('split')!='development' or c.get('optimizerConsent') is not True for c in cases): raise ValueError('OPTIMIZER_DATA_NOT_AUTHORIZED')
    # Actual GEPA optimizer, callback-owned proposer, no default LLM/network client.
    if not cases: raise ValueError('EMPTY_CORPUS')
    # GEPA may evaluate parent, proposal and validation batches in an iteration.
    # Model requests remain under the separate hard pre-reserved shared Budget.
    return gepa.optimize(seed_candidate=seed,trainset=cases,valset=cases,adapter=adapter,max_metric_calls=3*max_candidates*len(cases),reflection_minibatch_size=min(3,len(cases)),display_progress_bar=False,
                         stop_callbacks=lambda state: adapter.proposal_count>=max_candidates-1)
