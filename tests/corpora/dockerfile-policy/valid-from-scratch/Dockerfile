ARG SCANTOR_BASE
FROM scratch AS files
COPY requirements.txt /data/requirements.txt
FROM ${SCANTOR_BASE}
COPY --from=files /data /task/data
COPY . .
