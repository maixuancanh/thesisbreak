"""Read-only Graphiti lexical adapter; exact content/authority stays with Node recall.

API inspected at getzep/graphiti 72b5c59c06607e09ea855be61b6ff5a3446fc951.
Method adaptation only; no upstream code copied. Install requirements-graphiti.txt
in a separate environment. A configured Graphiti client is injected by the worker,
never created from browser fields. No credentials or hosted backend are implied.
"""
import asyncio
import hashlib
import json
from datetime import date
from typing import Literal
from pydantic import Field, field_validator, model_validator
from .contracts import StrictModel, MemoryPointer, Id, timestamp


class EntityRef(StrictModel):
    kind: Literal['team', 'player', 'source', 'event', 'reason', 'condition']
    provider: Id
    nativeId: Id


class NativeEvent(StrictModel):
    provider: Id
    nativeId: Id
    date: str

    @field_validator('date')
    @classmethod
    def calendar(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError('INVALID_EVENT_DATE')
        return value


class MemoryScope(StrictModel):
    domain: Id | None = None
    competition: Id | None = None
    marketId: Id | None = None
    marketType: Id | None = None
    horizon: Id | None = None


class MemoryEdge(StrictModel):
    id: Id
    namespace: Id
    pointer: MemoryPointer
    event: NativeEvent
    entities: list[EntityRef] = Field(max_length=40)
    relation: Id
    text: str = Field(max_length=16000)
    evidenceIds: list[Id] = Field(min_length=1, max_length=100)
    recordedAt: str
    availableAt: str
    validFrom: str
    validTo: str | None
    trusted: bool
    scope: MemoryScope | None = None

    @model_validator(mode='after')
    def times(self):
        for value in (self.recordedAt, self.availableAt, self.validFrom):
            timestamp(value)
        if self.validTo is not None and timestamp(self.validTo) <= timestamp(self.validFrom):
            raise ValueError('INVALID_VALIDITY_INTERVAL')
        return self


class GraphQuery(StrictModel):
    ownerId: Id
    namespace: Id
    event: NativeEvent
    cutoffAt: str
    query: str = Field(max_length=12000)
    entities: list[EntityRef] = Field(max_length=40)
    topK: int = Field(default=20, ge=1, le=20)
    finalK: int = Field(default=5, ge=1, le=5)
    maxCharacters: int = Field(default=16000, ge=0, le=16000)
    scope: MemoryScope | None = None

    @field_validator('cutoffAt')
    @classmethod
    def time(cls, value):
        timestamp(value)
        return value


def graph_group_id(query: GraphQuery):
    """Ingestion must use this exact owner/namespace/native-event partition."""
    values = [query.ownerId, query.namespace, query.event.model_dump()]
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def eligible(query: GraphQuery, edge: MemoryEdge):
    cutoff = timestamp(query.cutoffAt)
    return (edge.pointer.ownerId == query.ownerId and edge.namespace == query.namespace
            and edge.event == query.event and edge.trusted
            and all((query.scope.model_dump(exclude_none=True) if query.scope else {}).get(k) == v for k, v in (edge.scope.model_dump(exclude_none=True) if edge.scope else {}).items())
            and all(timestamp(t) <= cutoff for t in (edge.recordedAt, edge.availableAt, edge.validFrom))
            and (edge.validTo is None or timestamp(edge.validTo) > cutoff))


async def search_graphiti(raw_query, client=None, timeout_seconds=10):
    """Returns bounded candidate edges, never verified context or a hybrid claim.

    Each Graphiti edge must carry attributes.thesisbreak_edge as canonical JSON
    matching MemoryEdge, plus owner_id/namespace/event_provider/event_native_id/
    event_date scalar properties. Extracted edges without reviewed pointers fail.
    """
    query = GraphQuery.model_validate(raw_query)
    if not 0 < timeout_seconds <= 60:
        raise ValueError('INVALID_GRAPH_TIMEOUT')
    unavailable = dict(status='unavailable', items=[], mode='lexical_entity', requiresRemoteReadback=True)
    if client is None:
        return {**unavailable, 'reason': 'backend_not_configured'}
    try:
        from graphiti_core.search.search_config import SearchConfig, EdgeSearchConfig, EdgeSearchMethod, EdgeReranker
        from graphiti_core.search.search_filters import SearchFilters, DateFilter, PropertyFilter, ComparisonOperator as Op
    except ImportError:
        return {**unavailable, 'reason': 'optional_dependency_missing'}
    cutoff = timestamp(query.cutoffAt)
    group_id = graph_group_id(query)
    filters = SearchFilters(
        created_at=[[DateFilter(date=cutoff, comparison_operator=Op.less_than_equal)]],
        valid_at=[[DateFilter(date=cutoff, comparison_operator=Op.less_than_equal)]],
        invalid_at=[[DateFilter(comparison_operator=Op.is_null)], [DateFilter(date=cutoff, comparison_operator=Op.greater_than)]],
        property_filters=[PropertyFilter(property_name=k, property_value=v, comparison_operator=Op.equals) for k, v in {
            'owner_id': query.ownerId, 'namespace': query.namespace,
            'event_provider': query.event.provider, 'event_native_id': query.event.nativeId,
            'event_date': query.event.date,
        }.items()],
    )
    # BM25+RRF performs no embedding request. Do not select MMR or a hybrid recipe.
    config = SearchConfig(edge_config=EdgeSearchConfig(search_methods=[EdgeSearchMethod.bm25], reranker=EdgeReranker.rrf), limit=query.topK)
    try:
        results = await asyncio.wait_for(client.search_(query=query.query, config=config, group_ids=[group_id], search_filter=filters), timeout=timeout_seconds)
    except Exception:
        return {**unavailable, 'reason': 'backend_search_failed'}
    selected = []
    seen = set()
    rejected = 0
    for raw_edge in results.edges:
        try:
            if raw_edge.group_id != group_id:
                raise ValueError('FOREIGN_GROUP')
            edge = MemoryEdge.model_validate_json(raw_edge.attributes['thesisbreak_edge'])
            if not eligible(query, edge):
                raise ValueError('INELIGIBLE_EDGE')
            key = json.dumps(edge.pointer.model_dump(), sort_keys=True)
            if key not in seen:
                selected.append(edge.model_dump(exclude_unset=True))
                seen.add(key)
        except (KeyError, TypeError, ValueError):
            rejected += 1
        if len(selected) >= query.topK:
            break
    return dict(status='ok', items=selected, rejected=rejected, mode='lexical_entity', requiresRemoteReadback=True)
