ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
ENV SCANTOR_CONNECTOR_CMD="xvfb-run -a python -m scantor.serve {entry}"
COPY . .
ENTRYPOINT ["python"]
CMD ["main.py"]
HEALTHCHECK CMD true
STOPSIGNAL SIGINT
