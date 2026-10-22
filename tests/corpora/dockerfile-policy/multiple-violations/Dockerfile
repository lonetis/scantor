ARG SCANTOR_BASE=python:3.14
FROM --platform=linux/arm64 localhost:5000/tasks/x:y AS stolen
FROM ${SCANTOR_BASE}
ADD https://example.com/x /x
VOLUME /data
CMD ["x"]
