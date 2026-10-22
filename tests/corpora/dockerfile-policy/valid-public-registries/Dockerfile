ARG SCANTOR_BASE
FROM ghcr.io/astral-sh/uv:0.13.4 AS uv
FROM docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS alpine
FROM ${SCANTOR_BASE}
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=alpine /etc/alpine-release /etc/alpine-release
COPY --from=quay.io/example/tools:1.0 /bin/tool /usr/local/bin/tool
COPY --from=8.8.8.8:5000/example/tools:1.0 /bin/tool2 /usr/local/bin/tool2
