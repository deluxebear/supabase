#!/usr/bin/env bash
# Disposable Phase 1 acceptance for the Compose lifecycle plugin.
#
# Builds a tiny Compose project (an allowlisted `auth` service with a
# healthcheck, a non-allowlisted `db` service, and fleet-docker-proxy with the
# lifecycle policy), then runs fleet-lifecycle-compose from the Fleet image the
# same way the Agent does: one process per phase, request on stdin.
#
# Proves: restart restarts the container; rollout recreates it and picks up env
# file changes; a rollout that turns the service unhealthy fails verification
# and the rollback cannot pretend success; the proxy refuses writes to
# non-allowlisted services and privileged or host-mounting container creation.
#
# Requires a local Docker daemon and FLEET_AGENT_IMAGE (a build of
# apps/backup-operator/Dockerfile.fleet-control).
set -Eeuo pipefail

IMAGE="${FLEET_AGENT_IMAGE:?set FLEET_AGENT_IMAGE to a Fleet image build}"
PROJECT="fleet-lifecycle-acceptance-$RANDOM"
WORK_DIR="$(mktemp -d)"
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
PROTOCOL="supabase.fleet.lifecycle.plugin.v1"

cleanup() {
  docker compose -p "$PROJECT" -f "$WORK_DIR/compose.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

docker pull -q alpine:3.22 >/dev/null
printf 'HEALTH=ok\n' > "$WORK_DIR/service.env"
cat > "$WORK_DIR/compose.yml" <<YAML
services:
  auth:
    image: alpine:3.22
    command: [sleep, infinity]
    env_file: [service.env]
    healthcheck:
      test: ["CMD", "sh", "-c", "[ \"\$\$HEALTH\" = ok ]"]
      interval: 1s
      timeout: 1s
      retries: 2
      start_period: 1s
  db:
    image: alpine:3.22
    command: [sleep, infinity]
  fleet-docker-proxy-lifecycle:
    image: $IMAGE
    user: "0:0"
    entrypoint: [/usr/local/bin/fleet-docker-proxy]
    environment:
      FLEET_DOCKER_PROXY_COMPOSE_PROJECT: $PROJECT
      FLEET_DOCKER_PROXY_POLICY: lifecycle
      FLEET_DOCKER_PROXY_SERVICES: auth
      FLEET_DOCKER_PROXY_BIND_PREFIXES: $WORK_DIR/binds
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [default, docker-lifecycle]
networks:
  docker-lifecycle:
    internal: true
YAML

compose() { docker compose -p "$PROJECT" -f "$WORK_DIR/compose.yml" --project-directory "$WORK_DIR" "$@"; }
compose up -d --wait auth db
compose up -d fleet-docker-proxy-lifecycle

plugin() {
  local phase="$1" action="$2" service="${3:-auth}"
  printf '{"schema":"%s","phase":"%s","action":"%s","parameters":{"service":"%s"}}' \
    "$PROTOCOL" "$phase" "$action" "$service" |
    docker run --rm -i --network "${PROJECT}_docker-lifecycle" \
      -v "$WORK_DIR:$WORK_DIR:ro" \
      -e FLEET_LIFECYCLE_COMPOSE_PROJECT="$PROJECT" \
      -e FLEET_LIFECYCLE_SERVICES=auth \
      -e FLEET_LIFECYCLE_DOCKER_ENDPOINT=http://fleet-docker-proxy-lifecycle:2375 \
      -e FLEET_LIFECYCLE_PROJECT_DIRECTORY="$WORK_DIR" \
      -e FLEET_LIFECYCLE_COMPOSE_FILES="$WORK_DIR/compose.yml" \
      -e FLEET_LIFECYCLE_VERIFY_TIMEOUT=30s \
      --entrypoint /usr/local/bin/fleet-lifecycle-compose "$IMAGE" \
      --protocol "$PROTOCOL" --phase "$phase" --action "$action"
}

proxy_status() {
  local method="$1" path="$2" body="${3:-}"
  docker run --rm --network "${PROJECT}_docker-lifecycle" curlimages/curl:8.10.1 \
    -s -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "http://fleet-docker-proxy-lifecycle:2375$path"
}

container_id() { compose ps -q "$1"; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$(container_id auth)"; }

echo "1. restart"
before_started="$(started_at)"
plugin observe runtime.restart | grep -q '"service":"auth"' || fail "observe did not report auth"
plugin apply runtime.restart >/dev/null
plugin verify runtime.restart | grep -q 'healthy' || fail "restart verification failed"
[ "$(started_at)" != "$before_started" ] || fail "restart did not restart the container"

echo "2. rollout picks up env file changes"
before_id="$(container_id auth)"
printf 'HEALTH=ok\nROLLOUT_MARKER=applied\n' > "$WORK_DIR/service.env"
plugin apply runtime.rollout >/dev/null
plugin verify runtime.rollout >/dev/null
after_id="$(container_id auth)"
[ "$after_id" != "$before_id" ] || fail "rollout did not recreate the container"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$after_id" | grep -q '^ROLLOUT_MARKER=applied$' ||
  fail "rollout did not apply the changed env file"

echo "3. unhealthy rollout fails verification and rollback"
printf 'HEALTH=bad\n' > "$WORK_DIR/service.env"
plugin apply runtime.rollout >/dev/null
if plugin verify runtime.rollout >/dev/null 2>&1; then fail "unhealthy rollout passed verification"; fi
if plugin rollback runtime.rollout >/dev/null 2>&1; then fail "rollback claimed success while the definition is still unhealthy"; fi
printf 'HEALTH=ok\n' > "$WORK_DIR/service.env"
plugin rollback runtime.rollout >/dev/null || fail "rollback did not recover once the definition was healthy"

echo "4. proxy boundaries"
if plugin observe runtime.restart db >/dev/null 2>&1; then fail "plugin accepted a non-allowlisted service"; fi
[ "$(proxy_status POST "/containers/$(container_id db)/restart")" = 403 ] || fail "proxy allowed restarting db"
[ "$(proxy_status POST /containers/create "{\"Labels\":{\"com.docker.compose.project\":\"$PROJECT\",\"com.docker.compose.service\":\"auth\"},\"HostConfig\":{\"Privileged\":true}}")" = 403 ] ||
  fail "proxy allowed a privileged container"
[ "$(proxy_status POST /containers/create "{\"Labels\":{\"com.docker.compose.project\":\"$PROJECT\",\"com.docker.compose.service\":\"auth\"},\"HostConfig\":{\"Binds\":[\"/:/host\"]}}")" = 403 ] ||
  fail "proxy allowed a host root bind"
[ "$(proxy_status POST /images/create?fromImage=alpine)" = 403 ] || fail "proxy allowed an image pull"

echo "PASS: Compose lifecycle plugin acceptance"
