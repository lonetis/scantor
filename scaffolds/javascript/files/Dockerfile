ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
