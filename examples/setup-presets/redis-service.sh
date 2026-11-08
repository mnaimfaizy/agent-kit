#!/usr/bin/env bash
# Agent-kit setup preset: a Redis service container started with `docker run`.
# Copy this file into your Caller's `setup_commands: |` block, after a
# toolchain preset if you need one. Your copy is yours to edit; the Kit never
# overwrites it.
#
# The reusable workflow cannot take a `services:` block from a Caller, so start
# the container here. It keeps running for the rest of the job: the agent and
# verify_commands can reach it on localhost. setup_commands run once in the
# implement job and once in the verify job, so the script removes any old
# container first.
set -euo pipefail

# Pin the image; a digest (redis:7-alpine@sha256:...) is stricter still.
REDIS_IMAGE="redis:7-alpine"

docker rm -f agent-kit-redis >/dev/null 2>&1 || true
docker run --detach --name agent-kit-redis --publish 127.0.0.1:6379:6379 \
  --health-cmd "redis-cli ping" --health-interval 2s --health-timeout 2s --health-retries 15 \
  "$REDIS_IMAGE" >/dev/null

for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' agent-kit-redis)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 1
done
if [ "$status" != "healthy" ]; then
  echo "::error::Redis did not become healthy (status: $status)."
  docker logs agent-kit-redis || true
  exit 1
fi

# A non-secret setting for later steps. Never write a password or token to
# $GITHUB_ENV here: the agent's tools see every variable it sets.
echo "REDIS_URL=redis://127.0.0.1:6379/0" >>"$GITHUB_ENV"
