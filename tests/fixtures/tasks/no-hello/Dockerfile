ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY . .
# Replaces the connector (warning W2): the runtime waits for a hello that never comes.
ENV SCANTOR_CONNECTOR_CMD="python /task/silent.py"
