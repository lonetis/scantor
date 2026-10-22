ARG SCANTOR_BASE
FROM $SCANTOR_BASE AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
FROM base AS deps
COPY requirements.txt .
RUN pip install -r requirements.txt
FROM deps
COPY . .
