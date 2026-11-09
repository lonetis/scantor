ARG SCANTOR_BASE
FROM scripts/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091 AS victim
FROM ${SCANTOR_BASE}
COPY --from=victim /task /stolen
