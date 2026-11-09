import pytest
from thesisbreak_research.calibration_experiment import evaluate

def row(i,at):
    return dict(eventId=f'event-{i}',availableAt=at,cutoffAt='2025-01-01T00:00:00Z',probability=.2 if i%2 else .8,label=int(i%2==0))

def data():
    return dict(train=[row(i,'2026-01-01T00:00:00Z') for i in range(120)],validation=[row(i,'2026-02-01T00:00:00Z') for i in range(120,140)],heldout=[row(i,'2026-03-01T00:00:00Z') for i in range(140,160)],fitAt='2026-01-15T00:00:00Z',selectionAt='2026-02-15T00:00:00Z',asOf='2026-03-15T00:00:00Z',methods=['beta','isotonic'])

def test_chronological_fit_selection_holdout_with_real_calibrators():
    payload=data()
    report=evaluate(payload)
    assert report['status']=='evaluated' and report['counts']['heldout']==20
    assert report['automaticPromotion'] is False and report['predictiveAccuracyEstablished'] is False
    payload['heldout']=[r|dict(label=1-r['label']) for r in payload['heldout']]
    assert evaluate(payload)['selectedMethod']==report['selectedMethod']

def test_split_leakage_and_future_labels_fail_closed():
    payload=data();payload['heldout'][0]['eventId']=payload['train'][0]['eventId']
    with pytest.raises(ValueError,match='EVENT_LEAKAGE'):evaluate(payload)
    payload=data();payload['validation'][0]['availableAt']='2026-04-01T00:00:00Z'
    with pytest.raises(ValueError,match='FUTURE_LABEL'):evaluate(payload)

def test_thin_data_retains_abstention_instead_of_improvement():
    payload=data();payload['train']=payload['train'][:10]
    report=evaluate(payload)
    assert report['status']=='abstained' and report['benefitDemonstrated'] is False
