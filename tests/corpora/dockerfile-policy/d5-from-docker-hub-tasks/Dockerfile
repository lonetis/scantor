ARG SCANTOR_BASE
FROM tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:draft-a3f1 AS victim
FROM ${SCANTOR_BASE}
COPY --from=victim /task /stolen
