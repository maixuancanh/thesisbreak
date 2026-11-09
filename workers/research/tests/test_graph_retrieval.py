import asyncio
import importlib.util
import json
from types import SimpleNamespace
import pytest
from thesisbreak_research.graph_retrieval import GraphQuery, graph_group_id, search_graphiti

AT = '2026-10-30T00:00:00Z'
QUERY = dict(ownerId='owner', namespace='synthetic:graph', event=dict(provider='kalshi', nativeId='game', date='2026-11-02'), cutoffAt=AT, query='lineup', entities=[])
EDGE = dict(id='e', namespace=QUERY['namespace'], pointer=dict(ownerId='owner', memoryId='m', version=1, sha256='a'*64, blobId='b'), event=QUERY['event'], entities=[], relation='condition', text='official lineup', evidenceIds=['source'], recordedAt=AT, availableAt=AT, validFrom=AT, validTo=None, trusted=True)


def test_unconfigured_and_invalid_query():
    assert asyncio.run(search_graphiti(QUERY))['reason'] == 'backend_not_configured'
    with pytest.raises(ValueError):
        asyncio.run(search_graphiti({**QUERY, 'ownerId': ''}))
    assert graph_group_id(GraphQuery.model_validate(QUERY)) != graph_group_id(GraphQuery.model_validate({**QUERY, 'ownerId': 'foreign'}))


@pytest.mark.skipif(importlib.util.find_spec('graphiti_core') is not None, reason='uses environment without optional dependency')
def test_missing_optional_dependency_is_not_empty_success():
    result = asyncio.run(search_graphiti(QUERY, client=object()))
    assert result['status'] == 'unavailable'
    assert result['reason'] == 'optional_dependency_missing'


@pytest.mark.skipif(importlib.util.find_spec('graphiti_core') is None, reason='requires optional pinned Graphiti environment')
def test_real_graphiti_config_no_embedding_and_cross_owner_filter():
    from graphiti_core.search.search_config import EdgeSearchMethod, EdgeReranker
    group = graph_group_id(GraphQuery.model_validate(QUERY))
    class Client:
        async def search_(self, **kwargs):
            assert kwargs['group_ids'] == [group]
            assert kwargs['config'].edge_config.search_methods == [EdgeSearchMethod.bm25]
            assert kwargs['config'].edge_config.reranker == EdgeReranker.rrf
            assert len(kwargs['search_filter'].property_filters) == 5
            malicious = {**EDGE, 'pointer': {**EDGE['pointer'], 'ownerId': 'foreign'}}
            future = {**EDGE, 'recordedAt': '2026-11-01T00:00:00Z'}
            values = [EDGE, malicious, future, EDGE]
            return SimpleNamespace(edges=[SimpleNamespace(group_id=group, attributes={'thesisbreak_edge': json.dumps(e)}) for e in values])
    result = asyncio.run(search_graphiti(QUERY, Client()))
    assert result['status'] == 'ok'
    assert len(result['items']) == 1
    assert result['rejected'] == 2
    assert result['requiresRemoteReadback'] is True


@pytest.mark.skipif(importlib.util.find_spec('graphiti_core') is None, reason='requires optional pinned Graphiti environment')
def test_backend_failure_is_unavailable():
    class Broken:
        async def search_(self, **kwargs):
            raise RuntimeError('private DB URL must not be included')
    result = asyncio.run(search_graphiti(QUERY, Broken()))
    assert result['status'] == 'unavailable'
    assert result['reason'] == 'backend_search_failed'
    assert 'private' not in json.dumps(result)
