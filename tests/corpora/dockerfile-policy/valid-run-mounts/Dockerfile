ARG SCANTOR_BASE
FROM alpine:3.24 AS assets
RUN mkdir -p /assets && echo data > /assets/data.txt
FROM ${SCANTOR_BASE}
RUN --mount=type=bind,from=assets,source=/assets,target=/mnt/assets cp /mnt/assets/data.txt /task/
RUN --mount=type=tmpfs,target=/scratch echo scratch > /scratch/x
RUN --mount=type=bind,source=requirements.txt,target=/tmp/requirements.txt pip install -r /tmp/requirements.txt
RUN --network=default true
COPY . .
