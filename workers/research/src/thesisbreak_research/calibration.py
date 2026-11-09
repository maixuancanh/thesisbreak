"""Chronological diagnostics; these are research challengers, never promotion."""
import math
import random
from collections import defaultdict
from .contracts import timestamp

EPSILON=1e-12


def diagnostics(probabilities, labels, bins=10):
    from netcal.metrics import ECE
    import numpy as np
    if not 1<=bins<=100 or len(probabilities)!=len(labels): raise ValueError('INVALID_COHORT')
    if any(type(p) not in (int,float) or not math.isfinite(p) or not 0<=p<=1 for p in probabilities): raise ValueError('INVALID_PROBABILITY')
    if any(type(y) is not int or y not in (0,1) for y in labels): raise ValueError('INVALID_LABEL')
    n=len(labels)
    buckets=[[] for _ in range(bins)]
    for p,y in zip(probabilities,labels): buckets[min(int(p*bins),bins-1)].append((p,y))
    reliability=[dict(lower=i/bins,upper=(i+1)/bins,count=len(rows),meanProbability=sum(p for p,y in rows)/len(rows) if rows else None,observedFrequency=sum(y for p,y in rows)/len(rows) if rows else None) for i,rows in enumerate(buckets)]
    return dict(samples=n,brier=sum((p-y)**2 for p,y in zip(probabilities,labels))/n if n else None,logLoss=-sum(y*math.log(max(EPSILON,min(1-EPSILON,p)))+(1-y)*math.log(max(EPSILON,min(1-EPSILON,1-p))) for p,y in zip(probabilities,labels))/n if n else None,ece=float(ECE(bins).measure(np.array(probabilities),np.array(labels))) if n else None,bins=reliability,epsilon=EPSILON,probabilities=probabilities,method='netcal.ECE')


def validate_split(train, heldout, fit_at):
    cutoff=timestamp(fit_at)
    if {r['eventId'] for r in train}&{r['eventId'] for r in heldout}: raise ValueError('EVENT_LEAKAGE')
    if any(timestamp(r['availableAt'])>cutoff for r in train): raise ValueError('FUTURE_LABEL')
    if any(timestamp(r['availableAt'])<=cutoff for r in heldout): raise ValueError('NON_CHRONOLOGICAL_HOLDOUT')


def cluster_bootstrap(rows,repeats=1000,seed=0):
    if not rows or not 100<=repeats<=10000: raise ValueError('INVALID_BOOTSTRAP')
    clusters=defaultdict(list)
    for r in rows:
        delta=r['challenger']-r['baseline']
        if not math.isfinite(delta): raise ValueError('NONFINITE_SCORE')
        clusters[r['eventId']].append(delta)
    keys=sorted(clusters)
    rng=random.Random(seed)
    draws=[]
    for _ in range(repeats):
        values=[v for k in rng.choices(keys,k=len(keys)) for v in clusters[k]]
        draws.append(sum(values)/len(values))
    draws.sort()
    return dict(delta=sum(v for values in clusters.values() for v in values)/len(rows),lower95=draws[int(repeats*.025)],upper95=draws[min(repeats-1,int(repeats*.975))],clusters=len(keys),repeats=repeats,seed=seed,unit='event')


def fit_challenger(method,train,heldout,fit_at):
    """No sealed-set selection; caller freezes and authorizes comparison separately."""
    import numpy as np
    validate_split(train,heldout,fit_at)
    if len({r['eventId'] for r in train})<100 or any(sum(r['label']==y for r in train)<20 for y in (0,1)):
        return dict(status='abstained',reason='insufficient_training_support',predictions=None)
    # Validate probabilities/labels before package fit; duplicates cannot inflate support.
    diagnostics([r['probability'] for r in train],[r['label'] for r in train])
    if len({r['eventId'] for r in train})!=len(train): raise ValueError('ONE_TRAINING_SAMPLE_PER_EVENT_REQUIRED')
    x=np.array([r['probability'] for r in train]); y=np.array([r['label'] for r in train]); test=np.array([r['probability'] for r in heldout])
    try:
        if method=='logistic':
            import pandas as pd
            from forecasting_tools.calibration_adjustment.logistic_recalibration_adjuster import LogisticRecalibrationAdjuster
            model=LogisticRecalibrationAdjuster()
            model.train(pd.DataFrame(dict(type=['binary']*len(train),probability_yes=x,resolution=['yes' if v else 'no' for v in y])))
            predictions=[model.adjust_binary_forecast(float(p)) for p in test]
        elif method in ('beta','isotonic'):
            from netcal.scaling import BetaCalibration
            from netcal.binning import IsotonicRegression
            model=BetaCalibration() if method=='beta' else IsotonicRegression()
            model.fit(x,y)
            predictions=model.transform(test).tolist()
        else: raise ValueError('UNSUPPORTED_CHALLENGER')
        if any(not math.isfinite(p) or not 0<=p<=1 for p in predictions): raise ValueError('UNSTABLE_FIT')
        return dict(status='ok',method=method,predictions=predictions,trainingEvents=len(train))
    except (ValueError,RuntimeError,FloatingPointError):
        return dict(status='abstained',reason='unstable_fit',predictions=None)
