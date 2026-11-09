"""Trusted subprocess bridge; no HTTP listener and no inherited application secrets."""
import asyncio
import contextlib
import json
import os
import sys
from .graph_driver import execute_graph_request


def main():
    try:
        raw = sys.stdin.buffer.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError('INPUT_LIMIT')
        request = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(execute_graph_request(request, os.environ))
        print(json.dumps(dict(ok=True, result=result), separators=(',', ':')))
    except Exception:
        print(json.dumps(dict(ok=False, error='GRAPHITI_UNAVAILABLE')))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
