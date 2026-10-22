FROM alpine:3.24 AS tools
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY --from=tools /bin/busybox /bin/busybox
