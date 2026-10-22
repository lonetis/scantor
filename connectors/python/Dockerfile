# scantor-base-python: Python 3.14 + the scantor connector + the ENV contract (docs/tasks.md §4.2), and its
# test stage. Build context: the repository root (docker-bake.hcl targets base-python and base-python-test).

ARG PYTHON_IMAGE=python:3.14-slim-trixie

FROM ghcr.io/astral-sh/uv:0.13.4 AS uv

# The connector as a wheel, with the scantor version it reports in `hello` stamped into _version.py.
FROM ${PYTHON_IMAGE} AS wheel
ARG VERSION=dev
COPY connectors/python/pyproject.toml /build/pyproject.toml
COPY connectors/python/src /build/src
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    python -c 'import sys; open(sys.argv[1], "w").write(f"__version__ = {sys.argv[2]!r}\n")' \
      /build/src/scantor/_version.py "${VERSION#v}" \
 && uv build --wheel --no-cache --out-dir /dist /build

FROM ${PYTHON_IMAGE} AS base
ENV PIP_CONSTRAINT=/opt/scantor/constraints.txt \
    UV_CONSTRAINT=/opt/scantor/constraints.txt \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore
COPY connectors/python/constraints.txt /opt/scantor/constraints.txt
# The connector and its pinned dependencies (plus debugpy for SCANTOR_DEBUG_CMD) are installed
# system-wide; the constraints keep task requirements from replacing them. basedpyright, the tool of
# SCANTOR_CHECK_CMD, gets its own virtualenv, trimmed to what its command line needs: no npm, no C
# headers, no source maps and no language server (editors bring their own).
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    --mount=from=wheel,source=/dist,target=/tmp/dist \
    uv pip install --system --no-cache --compile-bytecode /tmp/dist/scantor-*.whl debugpy \
 && uv venv --no-cache --python /usr/local/bin/python3 /opt/scantor/tools \
 && uv pip install --no-cache --python /opt/scantor/tools/bin/python basedpyright==1.40.2 \
 && site=/opt/scantor/tools/lib/python3.14/site-packages \
 && rm -rf "$site/nodejs_wheel/include" "$site/nodejs_wheel/lib/node_modules" "$site/nodejs_wheel/share" \
      "$site/nodejs_wheel/bin/npm" "$site/nodejs_wheel/bin/npx" "$site/nodejs_wheel/bin/corepack" \
      "$site/basedpyright/dist/pyright-langserver.js" \
 && find "$site/basedpyright/dist" -name '*.map' -delete \
 && /opt/scantor/tools/bin/basedpyright --version
ENV SCANTOR_LANGUAGE=python \
    SCANTOR_CONNECTOR_CMD="python -m scantor.serve {entry}" \
    SCANTOR_CHECK_CMD="python -m scantor.check {entry}" \
    SCANTOR_DEBUG_CMD="python -m debugpy --listen 0.0.0.0:5678 --wait-for-client -m scantor.serve {entry}" \
    SCANTOR_DEBUG_PORT=5678
WORKDIR /task

# Connector tests: ruff, basedpyright and pytest against the installed connector, the Python examples,
# the Python scaffold and the Python guide. `just test-connectors python` runs it with --network none.
FROM base AS test
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv pip install --system --no-cache \
      "pytest>=9.1" "pytest-asyncio>=1.4" "ruff==0.17.1" "jsonschema>=4.25" "pyyaml>=6.0.3" "httpx>=0.28.1,<1"
COPY schemas /src/schemas
COPY scaffolds/python /src/scaffolds/python
COPY tasks/echo /src/tasks/echo
COPY tasks/sleep /src/tasks/sleep
COPY tasks/throws /src/tasks/throws
COPY tasks/files /src/tasks/files
COPY tasks/origins /src/tasks/origins
COPY docs/guide/authoring-python.md /src/docs/guide/authoring-python.md
COPY connectors/python /src/connectors/python
WORKDIR /src/connectors/python
CMD ["sh", "-c", "ruff check . && ruff format --check . && /opt/scantor/tools/bin/basedpyright --pythonpath /usr/local/bin/python && pytest -q"]
