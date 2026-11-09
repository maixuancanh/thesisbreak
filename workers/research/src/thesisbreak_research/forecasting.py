import asyncio
import time
from dataclasses import dataclass, field


@dataclass
class Budget:
    max_calls: int
    max_tokens: int
    deadline_seconds: float = 60
    calls: int = 0
    tokens: int = 0
    started: float = field(default_factory=time.monotonic)

    def reserve(self, calls, tokens):
        if calls<0 or tokens<0 or time.monotonic()-self.started>self.deadline_seconds or self.calls+calls>self.max_calls or self.tokens+tokens>self.max_tokens:
            raise ValueError('BUDGET_EXCEEDED')
        self.calls+=calls
        self.tokens+=tokens


def ensemble(components):
    from forecasting_tools.data_models.binary_report import BinaryReport
    valid=[c.probability for c in components if c.status=='ok']
    probability=asyncio.run(BinaryReport.aggregate_predictions(valid, None)) if len(valid)>=2 else None
    return dict(probability=probability,status='ok' if probability is not None else 'unavailable',attempted=len(components),succeeded=len(valid),independentOrigins=len({o for c in components if c.status=='ok' for o in c.originIds}),method='forecasting-tools.BinaryReport.median',independenceClaim=False)


async def run_components(envelope, providers):
    """Providers receive only frozen envelope and a shared pre-reserved budget.

    Each provider must reserve every subcall before sending it. Network provider
    credentials/configuration are intentionally supplied outside the job payload.
    """
    from .contracts import ComponentForecast, validate_components
    if len(providers)>3: raise ValueError('COMPONENT_LIMIT')
    budget=Budget(envelope.maxCalls,envelope.maxOutputTokens)
    results=[]
    for component_id, provider, token_cap in providers:
        try:
            budget.reserve(1,token_cap)
            row=await asyncio.wait_for(provider(envelope.model_copy(deep=True), budget),timeout=max(.01,budget.deadline_seconds-(time.monotonic()-budget.started)))
            parsed=ComponentForecast.model_validate(row)
            if parsed.componentId != component_id: raise ValueError('COMPONENT_ID_MISMATCH')
            results.append(parsed)
        except Exception as error:
            results.append(ComponentForecast(componentId=component_id,probability=None,status='failed',evidenceIds=[],originIds=[],assumptions=[],failureCode='budget_exceeded' if isinstance(error,ValueError) and str(error)=='BUDGET_EXCEEDED' else 'provider_failed'))
    return validate_components(envelope,results)
