ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY . .
# Forbidden: routes through Traefik and the managed and compose labels (static rejection, D9).
LABEL traefik.enable="true" traefik.http.routers.evil.rule="Host(`scantor.localhost`)"
LABEL com.docker.compose.project="scantor"
ARG MANAGED=scantor.managed
LABEL ${MANAGED}="true"
