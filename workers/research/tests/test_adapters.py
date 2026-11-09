import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from thesisbreak_research.calibration import fit_challenger,validate_split
from thesisbreak_research.contracts import ResearchEnvelope
from thesisbreak_research.forecasting import run_components
from test_worker import envelope


def test_all_real_calibrators_fit_without_network():
    train=[dict(eventId=f'e{i}',availableAt='2026-01-01T00:00:00Z',probability=.2 if i%4<2 else .8,label=int(i%4>=2) if i%5 else int(i%4<2)) for i in range(120)]
    holdout=[dict(eventId='future',availableAt='2026-02-01T00:00:00Z',probability=.6,label=1)]
    for method in ('logistic','beta','isotonic'):
        result=fit_challenger(method,train,holdout,'2026-01-15T00:00:00Z')
        assert result['status']=='ok', (method,result)
        assert 0<=result['predictions'][0]<=1
    with pytest.raises(ValueError): validate_split(train,holdout,'2025-01-01T00:00:00Z')


def test_provider_budget_reserved_before_dispatch():
    called=[]
    async def provider(env,budget):
        called.append(env.jobId)
        return dict(componentId='a',probability=.5,status='ok',evidenceIds=[],originIds=[],assumptions=[],failureCode=None)
    env=ResearchEnvelope.model_validate(envelope()|{'maxCalls':1})
    rows=asyncio.run(run_components(env,[('a',provider,50),('b',provider,50)]))
    assert called==['j'] and rows[1].failureCode=='budget_exceeded'


def test_json_cli_redacts_and_validates():
    root=Path(__file__).resolve().parents[1]
    env=os.environ|{'PYTHONPATH':str(root/'src')}
    proc=subprocess.run([sys.executable,'-m','thesisbreak_research.cli'],input=json.dumps({'operation':'validate_contract','payload':envelope()}),text=True,capture_output=True,env=env)
    assert proc.returncode==0 and json.loads(proc.stdout)=={'ok':True,'result':{'valid':True}}
    proc=subprocess.run([sys.executable,'-m','thesisbreak_research.cli'],input=json.dumps({'operation':'validate_contract','payload':{'secret':'sensitive-marker'}}),text=True,capture_output=True,env=env)
    assert proc.returncode==1 and 'sensitive-marker' not in proc.stdout+proc.stderr
