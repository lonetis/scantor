ARG SCANTOR_BASE
FROM ${SCANTOR_BASE} AS task
COPY . .
FROM alpine:3.24
COPY --from=task /task /task
