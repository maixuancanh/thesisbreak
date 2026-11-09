"""One bounded JSON request on stdin, one JSON response on stdout."""
import contextlib
import importlib.metadata
import json
import sys
from typing import Literal
from .contracts import StrictModel,ResearchEnvelope,ComponentForecast,validate_components


class Request(StrictModel):
    operation: Literal['validate_contract','forecast','calibration','calibration_experiment','online_learning','procedure_evaluate','procedure_optimize','capabilities']
    payload: dict


def dispatch(request):
    op=request.operation; payload=request.payload
    if op=='validate_contract':
        ResearchEnvelope.model_validate(payload)
        return {'valid':True}
    if op=='capabilities':
        versions={}
        for name in ('forecasting-tools','river','netcal','gepa','pydantic'):
            try: versions[name]=importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError: versions[name]=None
        return dict(versions=versions,hostedVerified=False,benefitDemonstrated=False,networkProvidersConfigured=False)
    if op=='forecast':
        if set(payload)!={'envelope','components'}: raise ValueError('INVALID_FORECAST_PAYLOAD')
        env=ResearchEnvelope.model_validate(payload['envelope'])
        components=validate_components(env,[ComponentForecast.model_validate(c) for c in payload['components']])
        from .forecasting import ensemble
        return ensemble(components)
    if op=='calibration':
        if set(payload)-{'probabilities','labels','bins'}: raise ValueError('INVALID_CALIBRATION_PAYLOAD')
        from .calibration import diagnostics
        return diagnostics(**payload)
    if op=='calibration_experiment':
        from .calibration_experiment import evaluate
        return evaluate(payload)
    if op=='online_learning':
        if set(payload)!={'rows','asOf'} or len(payload['rows'])>100000: raise ValueError('INVALID_ONLINE_PAYLOAD')
        from .online_learning import rebuild
        return rebuild(payload['rows'],payload['asOf'])
    if op=='procedure_evaluate':
        from .procedure_optimizer import evaluate_recorded
        return evaluate_recorded(payload)
    if op=='procedure_optimize':
        from .procedure_optimizer import optimize_action_replay
        return optimize_action_replay(payload)
    raise ValueError('UNKNOWN_OPERATION')


def main():
    try:
        raw=sys.stdin.buffer.read(4_000_001)
        if len(raw)>4_000_000: raise ValueError('INPUT_LIMIT')
        request=Request.model_validate(json.loads(raw,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON'))))
        # Third-party diagnostics may print. Keep stdout machine-readable.
        with contextlib.redirect_stdout(sys.stderr): result=dispatch(request)
        print(json.dumps(dict(ok=True,result=result),allow_nan=False,separators=(',',':')))
    except Exception as error:
        code='dependency_unavailable' if isinstance(error,ImportError) else 'invalid_request_or_failed_job'
        print(json.dumps(dict(ok=False,error={'code':code})))
        return 1
    return 0


if __name__=='__main__': sys.exit(main())
