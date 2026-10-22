ARG SCANTOR_BASE
FROM golang:1.27-alpine AS builder
WORKDIR /src
COPY . .
RUN go build -o /out/tool ./cmd/tool
FROM ${SCANTOR_BASE}
COPY --from=builder /out/tool /usr/local/bin/tool
COPY . .
