"""Frozen chronological challenger selection. No production promotion or live accuracy claim."""
import hashlib
import json
from .calibration import diagnostics, fit_challenger, validate_split, cluster_bootstrap
from .contracts import timestamp


def evaluate(payload):
    if set(payload) != {'train','validation','heldout','fitAt','selectionAt','asOf','methods'}:
        raise ValueError('INVALID_EXPERIMENT')
    train, validation, heldout = (payload[k] for k in ('train','validation','heldout'))
    if not all(isinstance(rows,list) and 0 < len(rows) <= 10000 for rows in (train,validation,heldout)):
        raise ValueError('EMPTY_OR_OVERSIZED_SPLIT')
    methods=payload['methods']
    if not methods or len(set(methods)) != len(methods) or any(m not in ('logistic','beta','isotonic') for m in methods):
        raise ValueError('INVALID_METHODS')
    if not timestamp(payload['fitAt']) < timestamp(payload['selectionAt']) <= timestamp(payload['asOf']):
        raise ValueError('INVALID_CUTOFFS')
    ids=[r['eventId'] for rows in (train,validation,heldout) for r in rows]
    if len(ids)!=len(set(ids)): raise ValueError('EVENT_LEAKAGE')
    for rows in (train,validation,heldout):
        diagnostics([r['probability'] for r in rows],[r['label'] for r in rows])
        if any(timestamp(r['availableAt'])>timestamp(payload['asOf']) for r in rows): raise ValueError('FUTURE_LABEL')
        if any(timestamp(r['cutoffAt'])>=timestamp(r['availableAt']) for r in rows): raise ValueError('INVALID_EVENT_TIME')
    validate_split(train,validation,payload['fitAt'])
    if any(timestamp(r['availableAt'])>timestamp(payload['selectionAt']) for r in validation): raise ValueError('FUTURE_VALIDATION_LABEL')
    validate_split(train+validation,heldout,payload['selectionAt'])
    artifact_hash=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    base=dict(inputHash=artifact_hash,mode='retrospective_chronological',counts=dict(train=len(train),validation=len(validation),heldout=len(heldout)),automaticPromotion=False,benefitDemonstrated=False)
    candidates=[]
    for method in methods:
        fitted=fit_challenger(method,train,validation,payload['fitAt'])
        candidates.append(dict(method=method,fit=fitted,validation=diagnostics(fitted['predictions'],[r['label'] for r in validation]) if fitted['status']=='ok' else None))
    eligible=[c for c in candidates if c['validation'] is not None]
    if not eligible: return base|dict(status='abstained',reason='insufficient_or_unstable_training',candidates=candidates,selectedMethod=None)
    # Heldout labels and scores are never inspected to choose this method.
    selected=min(eligible,key=lambda c:(c['validation']['brier'],c['method']))['method']
    final=fit_challenger(selected,train+validation,heldout,payload['selectionAt'])
    if final['status']!='ok': return base|dict(status='abstained',reason='selected_refit_unavailable',candidates=candidates,selectedMethod=selected)
    labels=[r['label'] for r in heldout]
    baseline=diagnostics([r['probability'] for r in heldout],labels)
    challenger=diagnostics(final['predictions'],labels)
    deltas=[dict(eventId=r['eventId'],baseline=(r['probability']-r['label'])**2,challenger=(p-r['label'])**2) for r,p in zip(heldout,final['predictions'])]
    return base|dict(status='evaluated',selectedMethod=selected,candidates=candidates,heldoutBaseline=baseline,heldoutChallenger=challenger,eventClusterBrier=cluster_bootstrap(deltas,repeats=1000,seed=0),predictiveAccuracyEstablished=False)
