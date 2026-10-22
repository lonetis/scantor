ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG SCANTOR_GCFLAGS=""
RUN for t in single list range repeat tranco crux cidr; do go build -gcflags="${SCANTOR_GCFLAGS}" -o /task/models-$t ./cmd/$t || exit 1; done && cp /task/models-range /task/task
