from datetime import datetime
from typing import Annotated, Literal
import re
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

Id = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Hash = Annotated[str, StringConstraints(pattern=r'^[a-f0-9]{64}$')]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


def timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)', value):
        raise ValueError('INVALID_TIMESTAMP')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class EvidenceRef(StrictModel):
    id: Id
    sha256: Hash
    originId: Id
    url: str
    observedAt: str
    publishedAt: str | None
    availableAt: str
    eventId: Id

    @field_validator('url')
    @classmethod
    def https(cls,v):
        from urllib.parse import urlsplit
        p=urlsplit(v)
        if p.scheme != 'https' or not p.netloc: raise ValueError('HTTPS_REQUIRED')
        return v

    @field_validator('observedAt','publishedAt','availableAt')
    @classmethod
    def times(cls,v):
        if v is not None: timestamp(v)
        return v


class ResearchEnvelope(StrictModel):
    schemaVersion: Literal[1]
    jobId: Id
    namespace: Id
    mode: Literal['synthetic','historical_replay','prospective']
    ownerId: Id
    eventId: Id
    marketId: Id
    outcomeId: Id
    cutoffAt: str
    eventStartAt: str
    evidence: Annotated[list[EvidenceRef],Field(min_length=1,max_length=100)]
    modelVersion: Id
    procedureVersion: Id
    maxCalls: Annotated[int,Field(ge=1,le=20)]
    maxOutputTokens: Annotated[int,Field(ge=1,le=32000)]

    @field_validator('schemaVersion',mode='before')
    @classmethod
    def literal_number(cls,v):
        if type(v) is not int: raise ValueError('INVALID_SCHEMA_VERSION')
        return v

    @model_validator(mode='after')
    def chronology(self):
        cutoff=timestamp(self.cutoffAt)
        if cutoff >= timestamp(self.eventStartAt): raise ValueError('CUTOFF_NOT_PRE_EVENT')
        if len({e.id for e in self.evidence}) != len(self.evidence): raise ValueError('DUPLICATE_EVIDENCE')
        for e in self.evidence:
            if e.eventId != self.eventId: raise ValueError('EVENT_MISMATCH')
            if timestamp(e.observedAt)>timestamp(e.availableAt): raise ValueError('INVALID_AVAILABILITY')
            if timestamp(e.availableAt)>cutoff: raise ValueError('FUTURE_EVIDENCE')
            if e.publishedAt and timestamp(e.publishedAt)>timestamp(e.observedAt): raise ValueError('INVALID_PUBLICATION_TIME')
            if self.mode=='historical_replay' and e.publishedAt is None: raise ValueError('REPLAY_PUBLICATION_REQUIRED')
        return self


class MemoryPointer(StrictModel):
    ownerId: Id
    memoryId: Id
    version: Annotated[int,Field(gt=0)]
    sha256: Hash
    blobId: Id


class ComponentForecast(StrictModel):
    componentId: Id
    probability: Probability | None
    status: Literal['ok','abstained','failed']
    evidenceIds: Annotated[list[Id],Field(max_length=100)]
    originIds: Annotated[list[Id],Field(max_length=100)]
    assumptions: Annotated[list[Annotated[str,Field(max_length=2000)]],Field(max_length=20)]
    failureCode: Id | None

    @model_validator(mode='after')
    def coherence(self):
        if (self.status=='ok') != (self.probability is not None): raise ValueError('PROBABILITY_STATUS_MISMATCH')
        if (self.status=='failed') != (self.failureCode is not None): raise ValueError('FAILURE_CODE_STATUS_MISMATCH')
        return self


def validate_components(envelope, components):
    if len(components)>3: raise ValueError('COMPONENT_LIMIT')
    if len({c.componentId for c in components})!=len(components): raise ValueError('DUPLICATE_COMPONENT')
    refs={e.id:e for e in envelope.evidence}
    for c in components:
        if any(i not in refs for i in c.evidenceIds): raise ValueError('UNKNOWN_EVIDENCE')
        if set(c.originIds)!={refs[i].originId for i in c.evidenceIds}: raise ValueError('ORIGIN_MISMATCH')
    return components
