ARG SCANTOR_BASE
FROM ${SCANTOR_BASE} AS task
FROM python:3.14-slim AS other
FROM other
COPY --from=task /task /task
