"""Deterministic River rebuilds from canonical ledger revisions, no unsafe pickle."""
import hashlib
import json
from collections import defaultdict
from .contracts import timestamp


def rebuild(rows,as_of,delta=.002):
    from river import metrics,drift,linear_model,preprocessing
    if not 0<delta<1: raise ValueError('INVALID_DELTA')
    now=timestamp(as_of)
    eligible=[r for r in rows if timestamp(r['availableAt'])<=now]
    canonical={}; seen={}; revisions=0
    for r in sorted(eligible,key=lambda r:(timestamp(r['availableAt']),r['forecastId'],r['outcomeVersion'])):
        key=(r['forecastId'],r['outcomeVersion'],r['challengerVersion'])
        raw=json.dumps(r,sort_keys=True,separators=(',',':'),allow_nan=False)
        if key in seen:
            if seen[key]!=raw: raise ValueError('DUPLICATE_PAYLOAD_MISMATCH')
            continue
        seen[key]=raw
        if r['label'] not in (0,1) or type(r['label']) is not int or not 0<=r['probability']<=1: raise ValueError('INVALID_OBSERVATION')
        if timestamp(r['cutoffAt'])>=timestamp(r['availableAt']): raise ValueError('LABEL_BEFORE_FORECAST')
        identity=(r['forecastId'],r['challengerVersion'])
        previous=canonical.get(identity)
        if previous:
            if r['outcomeVersion']<=previous['outcomeVersion']: raise ValueError('OUTCOME_VERSION_REGRESSION')
            revisions+=1
        canonical[identity]=r
    ordered=sorted(canonical.values(),key=lambda r:(timestamp(r['availableAt']),r['forecastId']))
    streams={}; brier=metrics.MSE(); logloss=metrics.LogLoss(); learned=[]
    for r in ordered:
        stream=(r['league'],r['marketType'],r['horizon'],r['challengerVersion'])
        state=streams.setdefault(stream,dict(detector=drift.ADWIN(delta=delta),count=0,events=set(),model=preprocessing.StandardScaler()|linear_model.LogisticRegression(),detected=False))
        # Frozen forecast is scored before updating the derived challenger.
        p=r['probability']; y=r['label']; brier.update(y,p); logloss.update(y,p)
        features={'frozenProbability':p}
        prediction=state['model'].predict_proba_one(features).get(True,.5)
        learned.append(dict(forecastId=r['forecastId'],outcomeVersion=r['outcomeVersion'],predictionBeforeLearning=prediction))
        state['model'].learn_one(features,bool(y))
        if r['primary'] and r['eventId'] not in state['events']:
            state['events'].add(r['eventId']); state['count']+=1
            state['detector'].update((p-y)**2)
            state['detected']=state['count']>=100 and state['detector'].drift_detected
    digest=hashlib.sha256(json.dumps(ordered,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    return dict(samples=len(ordered),brier=brier.get() if ordered else None,logLoss=logloss.get() if ordered else None,revisions=revisions,inputPrefixHash=digest,derivedState='rebuilt_after_correction' if revisions else 'current',streams=[dict(key=list(k),samples=v['count'],status='insufficient_history' if v['count']<100 else 'drift_review' if v['detected'] else 'stable',delta=delta,window=v['detector'].width) for k,v in sorted(streams.items())],trajectory=learned,method='river.predict_then_learn.ADWIN',automaticAuthority=False)
