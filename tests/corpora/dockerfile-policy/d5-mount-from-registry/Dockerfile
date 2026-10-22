ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
RUN --mount=type=bind,from=localhost:5000/tasks/x:y,target=/mnt cp -r /mnt /task/stolen
