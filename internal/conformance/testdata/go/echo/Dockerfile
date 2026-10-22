ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG SCANTOR_GCFLAGS=""
RUN go build -gcflags="${SCANTOR_GCFLAGS}" -o /task/task .
