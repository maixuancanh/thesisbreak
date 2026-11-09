"""Configured Neo4j driver for deterministic reviewed-edge ingestion and BM25 search.

Uses pinned Graphiti public models/search functions; no extraction, embedding, LLM,
or default provider clients are constructed. This is a derived candidate index.
"""
import asyncio
import hashlib
import json
from dataclasses import dataclass
from types import SimpleNamespace
from urllib.parse import urlsplit
from .contracts import timestamp
from .graph_retrieval import MemoryEdge, GraphQuery, graph_group_id, search_graphiti


@dataclass(frozen=True)
class GraphDriverConfig:
    uri: str
    user: str
    password: str
    database: str
    host: str

    @classmethod
    def from_env(cls, env, owner, operation):
        enabled = 'GRAPHITI_INGEST_ENABLED' if operation == 'ingest' else 'GRAPHITI_SEARCH_ENABLED'
        owners = {s.strip() for s in env.get('GRAPHITI_OWNER_IDS', '').split(',') if s.strip()}
        if operation not in ('ingest', 'search') or env.get(enabled) != 'true' or owner not in owners:
            raise ValueError('GRAPHITI_NOT_AUTHORIZED')
        uri = env.get('GRAPHITI_DATABASE_URI', '')
        parsed = urlsplit(uri)
        hosts = {s.strip().lower() for s in env.get('GRAPHITI_DATABASE_HOSTS', '').split(',') if s.strip()}
        host = (parsed.hostname or '').lower()
        local = host in ('localhost', '127.0.0.1', '::1')
        if (not host or host not in hosts or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or parsed.scheme not in ('bolt+s', 'neo4j+s', 'bolt', 'neo4j')
                or (not local and parsed.scheme not in ('bolt+s', 'neo4j+s'))):
            raise ValueError('GRAPHITI_DESTINATION_REJECTED')
        user, password = env.get('GRAPHITI_DATABASE_USER', ''), env.get('GRAPHITI_DATABASE_PASSWORD', '')
        if not user or not password:
            raise ValueError('GRAPHITI_CREDENTIALS_REQUIRED')
        return cls(uri, user, password, env.get('GRAPHITI_DATABASE_NAME', 'neo4j'), host)


def make_search_client(driver):
    from graphiti_core.search.search import search
    # The selected BM25+RRF recipe never calls either missing model client.
    clients = SimpleNamespace(driver=driver, embedder=None, cross_encoder=None, tracer=None, max_coroutines=1)
    class Client:
        async def search_(self, *, query, config, group_ids, search_filter):
            return await search(clients, query, group_ids, config, search_filter)
    return Client()


def stable_id(*parts):
    return hashlib.sha256(json.dumps(parts, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


async def ingest_edges(owner, namespace, raw_edges, driver):
    """Only trusted server materialization may call this. Never perform LLM extraction."""
    from graphiti_core.nodes import EntityNode
    from graphiti_core.edges import EntityEdge
    if not owner or not namespace or len(raw_edges) > 1000:
        raise ValueError('GRAPHITI_INGEST_LIMIT')
    edges = [MemoryEdge.model_validate(e) for e in raw_edges]
    seen = set()
    for edge in edges:
        if edge.pointer.ownerId != owner or edge.namespace != namespace or not edge.trusted or edge.id in seen:
            raise ValueError('GRAPHITI_INGEST_AUTHORITY_MISMATCH')
        seen.add(edge.id)
    # Validation completes before the first write. Scope replacement also removes
    # revoked/superseded edges when the reviewed local materialization becomes empty.
    await driver.execute_query('MATCH (n:Entity {owner_id:$owner, namespace:$namespace, thesisbreak_index:true}) DETACH DELETE n', owner=owner, namespace=namespace)
    for edge in sorted(edges, key=lambda e: e.id):
        query = GraphQuery(ownerId=owner, namespace=namespace, event=edge.event, cutoffAt=edge.availableAt, query='', entities=[])
        group = graph_group_id(query)
        attributes = dict(owner_id=owner, namespace=namespace, event_provider=edge.event.provider,
                          event_native_id=edge.event.nativeId, event_date=edge.event.date, thesisbreak_index=True)
        source = stable_id(group, edge.id, 'event')
        target = stable_id(group, edge.id, 'memory')
        for uuid, name in [(source, edge.event.nativeId), (target, edge.pointer.memoryId)]:
            await EntityNode(uuid=uuid, name=name, group_id=group, created_at=timestamp(edge.recordedAt), attributes=attributes).save(driver)
        await EntityEdge(uuid=stable_id(group, edge.id), source_node_uuid=source, target_node_uuid=target,
                         group_id=group, name=edge.relation, fact=edge.text, created_at=timestamp(edge.recordedAt),
                         valid_at=timestamp(edge.validFrom), invalid_at=timestamp(edge.validTo) if edge.validTo else None,
                         attributes={**attributes, 'thesisbreak_edge': json.dumps(edge.model_dump(exclude_unset=True), sort_keys=True, separators=(',', ':'))}).save(driver)
    return dict(status='ok', indexed=len(edges), mode='lexical_entity')


async def execute_graph_request(request, env, driver_factory=None):
    if set(request) != {'operation', 'payload'} or request['operation'] not in ('ingest', 'search'):
        raise ValueError('GRAPHITI_REQUEST_REJECTED')
    operation, payload = request['operation'], request['payload']
    owner = payload.get('ownerId')
    config = GraphDriverConfig.from_env(env, owner, operation)
    if driver_factory is None:
        from graphiti_core.driver.neo4j_driver import Neo4jDriver
        driver_factory = lambda c: Neo4jDriver(c.uri, c.user, c.password, database=c.database)
    driver = driver_factory(config)
    try:
        if operation == 'search':
            return await search_graphiti(payload, make_search_client(driver))
        if set(payload) != {'ownerId', 'namespace', 'edges'}:
            raise ValueError('GRAPHITI_INGEST_REQUEST_REJECTED')
        return await asyncio.wait_for(ingest_edges(owner, payload['namespace'], payload['edges'], driver), timeout=30)
    finally:
        await driver.close()
