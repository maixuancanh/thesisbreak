import asyncio
import json
from types import SimpleNamespace
import pytest
import importlib.util
from thesisbreak_research.graph_driver import GraphDriverConfig, ingest_edges, make_search_client
from thesisbreak_research.graph_retrieval import GraphQuery, graph_group_id, search_graphiti
from test_graph_retrieval import QUERY, EDGE

pytestmark = pytest.mark.skipif(importlib.util.find_spec('graphiti_core') is None, reason='requires isolated pinned Graphiti environment')

def test_config_requires_explicit_owner_destination_and_local_or_tls():
    with pytest.raises(ValueError):
        GraphDriverConfig.from_env({}, 'owner', 'search')
    env = {'GRAPHITI_SEARCH_ENABLED': 'true', 'GRAPHITI_OWNER_IDS': 'owner', 'GRAPHITI_DATABASE_URI': 'bolt://127.0.0.1:7687', 'GRAPHITI_DATABASE_HOSTS': '127.0.0.1', 'GRAPHITI_DATABASE_USER': 'neo4j', 'GRAPHITI_DATABASE_PASSWORD': 'test'}
    assert GraphDriverConfig.from_env(env, 'owner', 'search').host == '127.0.0.1'
    for changes in [{'GRAPHITI_OWNER_IDS': 'foreign'}, {'GRAPHITI_DATABASE_HOSTS': 'different'}, {'GRAPHITI_DATABASE_URI': 'bolt://remote.example:7687', 'GRAPHITI_DATABASE_HOSTS': 'remote.example'}]:
        with pytest.raises(ValueError): GraphDriverConfig.from_env({**env, **changes}, 'owner', 'search')

class Driver:
    def __init__(self):
        from graphiti_core.driver.driver import GraphProvider
        self.provider = GraphProvider.NEO4J
        self.graph_operations_interface = None
        self.calls = []
    async def execute_query(self, query, **kwargs):
        self.calls.append((query, kwargs))
        return [], None, None

def test_ingests_exact_reviewed_pointer_using_real_graphiti_models_and_driver_api():
    driver = Driver()
    result = asyncio.run(ingest_edges('owner', QUERY['namespace'], [EDGE], driver))
    assert result == {'status': 'ok', 'indexed': 1, 'mode': 'lexical_entity'}
    saved = [kwargs['edge_data'] for _, kwargs in driver.calls if 'edge_data' in kwargs]
    assert len(saved) == 1
    edge = saved[0]
    assert edge['group_id'] == graph_group_id(GraphQuery.model_validate(QUERY))
    assert json.loads(edge['thesisbreak_edge']) == EDGE
    assert edge['owner_id'] == 'owner'
    assert edge['valid_at'].isoformat().startswith('2026-10-30')
    assert edge['fact_embedding'] is None
    assert len([1 for _, kwargs in driver.calls if 'entity_data' in kwargs]) == 2

def test_rejects_untrusted_foreign_or_unprovenanced_edges_before_any_write():
    for changed in [{**EDGE, 'trusted': False}, {**EDGE, 'pointer': {**EDGE['pointer'], 'ownerId': 'foreign'}}, {**EDGE, 'evidenceIds': []}, {**EDGE, 'namespace': 'foreign'}]:
        driver = Driver()
        with pytest.raises(ValueError): asyncio.run(ingest_edges('owner', QUERY['namespace'], [changed], driver))
        assert driver.calls == []

def test_real_graphiti_lexical_search_api_uses_injected_driver_without_models(monkeypatch):
    from graphiti_core.driver.driver import GraphProvider
    from graphiti_core.edges import EntityEdge
    class SearchOps:
        async def edge_fulltext_search(self, *args, **kwargs):
            return [EntityEdge(uuid='e', source_node_uuid='a', target_node_uuid='b', group_id=graph_group_id(GraphQuery.model_validate(QUERY)), name='condition', fact='official lineup', created_at='2026-10-30T00:00:00Z', attributes={'thesisbreak_edge': json.dumps(EDGE)})]
    driver = SimpleNamespace(provider=GraphProvider.NEO4J, search_interface=SearchOps(), graph_operations_interface=None)
    result = asyncio.run(search_graphiti(QUERY, make_search_client(driver)))
    assert result['status'] == 'ok'
    assert result['items'] == [EDGE]
    assert result['mode'] == 'lexical_entity'

