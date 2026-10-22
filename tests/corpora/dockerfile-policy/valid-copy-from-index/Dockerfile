ARG SCANTOR_BASE
FROM busybox:1.37
RUN echo hi > /hello
FROM ${SCANTOR_BASE}
COPY --from=0 /hello /hello
