ARG SCANTOR_BASE
FROM ${SCANTOR_BASE} AS assets
RUN mkdir -p /assets
FROM ${SCANTOR_BASE}
RUN --mount=type=bind,from=0,target=/mnt/assets true
COPY . .
