#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  echo '请先复制 .env.example 为 .env 并填写本机凭据。' >&2
  exit 1
fi
mkdir -p data
docker build --platform linux/amd64 -t weave:phase1 .
docker run -d --rm --name weave --platform linux/amd64 \
  -u "$(id -u):$(id -g)" \
  -p 127.0.0.1:4318:4318 \
  --add-host host.docker.internal:host-gateway \
  --env-file .env -v "$PWD/data:/app/data" weave:phase1
