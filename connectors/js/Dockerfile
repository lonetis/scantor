# scantor-base-js: Node 26 + @scantor/connector + the ENV contract (docs/tasks.md §4.2). Serves TypeScript
# and JavaScript tasks. Build context: the repository root (docker-bake.hcl target base-js / base-js-test).

ARG NODE_IMAGE=node:26.12.1-trixie-slim

# Compiles the connector: Node refuses to strip types under node_modules, so the image ships JavaScript
# and declarations built from src/*.ts.
FROM ${NODE_IMAGE} AS build
WORKDIR /src/connectors/js
COPY connectors/js/package.json connectors/js/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY connectors/js/tsconfig.json connectors/js/tsconfig.build.json connectors/js/serve.js connectors/js/check.js ./
COPY connectors/js/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && find node_modules -type d -empty -delete
# The installed manifest: no development fields, no source condition (src/ is not shipped), and the
# scantor version the connector reports in `hello`.
ARG VERSION=dev
RUN node - <<'EOF'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const field of ["scripts", "devDependencies", "files"]) delete manifest[field];
for (const target of Object.values(manifest.exports)) {
  if (typeof target === "object") delete target["scantor-source"];
}
manifest.scantorVersion = process.env.VERSION;
fs.writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
EOF

# typescript and @types/node at the root /node_modules, for SCANTOR_CHECK_CMD and editors.
FROM ${NODE_IMAGE} AS check-tools
WORKDIR /opt/scantor/check-tools
COPY connectors/js/check-tools/package.json connectors/js/check-tools/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS base
# The slim Node image has no system CA bundle (Node bundles its own roots), but the injected Go runtime
# verifies TLS against the system roots: S3 transfers, AMQPS and the Tranco/CrUX data sources.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt
COPY --from=check-tools /opt/scantor/check-tools/node_modules /node_modules
# zod stays nested in the connector's own node_modules; tasks import the re-exported z.
COPY --from=build /src/connectors/js/package.json /src/connectors/js/serve.js /src/connectors/js/check.js /node_modules/@scantor/connector/
COPY --from=build /src/connectors/js/dist /node_modules/@scantor/connector/dist
COPY --from=build /src/connectors/js/node_modules /node_modules/@scantor/connector/node_modules
ENV SCANTOR_LANGUAGE="typescript javascript" \
    SCANTOR_CONNECTOR_CMD="node /node_modules/@scantor/connector/serve.js {entry}" \
    SCANTOR_CHECK_CMD="node /node_modules/@scantor/connector/check.js {entry}" \
    SCANTOR_DEBUG_CMD="node --inspect-brk=0.0.0.0:9229 /node_modules/@scantor/connector/serve.js {entry}" \
    SCANTOR_DEBUG_PORT=9229
WORKDIR /task

# The base image plus the connector's dev dependencies and tests; `just test-connectors js` runs it with
# --network none. The repository layout is kept under /repo: tests read the schemas, and serve the
# TypeScript/JavaScript examples, scaffolds and guides with the connector installed above.
FROM base AS test
WORKDIR /repo/connectors/js
COPY connectors/js/package.json connectors/js/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY schemas /repo/schemas
COPY tasks/http-status /repo/tasks/http-status
COPY tasks/power /repo/tasks/power
COPY scaffolds/typescript /repo/scaffolds/typescript
COPY scaffolds/javascript /repo/scaffolds/javascript
COPY docs/guide/authoring-typescript.md docs/guide/authoring-javascript.md /repo/docs/guide/
COPY connectors/js/tsconfig.json connectors/js/tsconfig.build.json connectors/js/serve.js connectors/js/check.js ./
COPY connectors/js/src ./src
COPY connectors/js/test ./test
CMD ["npm", "run", "test:all"]
