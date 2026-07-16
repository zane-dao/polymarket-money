#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_REL="experiments/batch-04b-r2-24-market-observation.yaml"
HASH_REL="experiments/batch-04b-r2-24-market-observation.sha256"
CONFIG_PATH="$REPO_ROOT/$CONFIG_REL"
UNIT="polymarket-batch-04b-r2-24-market-observation.service"
EXPERIMENT_ID="batch-04b-r2-24-market-observation"
MIN_FREE_BYTES=$((10 * 1024 * 1024 * 1024))
MAXIMUM_RUNTIME_SECONDS=$((150 * 60))

usage() {
  printf 'Usage: %s {preflight|launch|status|logs|stop}\n' "$0"
}

require_data_root() {
  if [[ -z "${POLY_DATA_ROOT:-}" ]]; then
    printf 'POLY_DATA_ROOT is required and must name a Linux-native filesystem.\n' >&2
    exit 2
  fi
  if [[ "$POLY_DATA_ROOT" != /* ]]; then
    printf 'POLY_DATA_ROOT must be absolute.\n' >&2
    exit 2
  fi
  DATA_ROOT="$(realpath -m -- "$POLY_DATA_ROOT")"
  case "$DATA_ROOT/" in
    /mnt/d/*|"$REPO_ROOT"/*)
      printf 'Experiment output must not be under /mnt/d or the Git repository: %s\n' "$DATA_ROOT" >&2
      exit 2
      ;;
  esac
  BASE_DIR="$DATA_ROOT/experiments/$EXPERIMENT_ID"
  SESSION_ID_FILE="$BASE_DIR/session-id"
  PID_FILE="$BASE_DIR/session.pid"
  RUNNER_FILE="$BASE_DIR/runner"
  HEARTBEAT_FILE="$BASE_DIR/heartbeat"
  STDOUT_FILE="$BASE_DIR/stdout.log"
  STDERR_FILE="$BASE_DIR/stderr.log"
  EXIT_FILE="$BASE_DIR/exit-status"
  STOP_REASON_FILE="$BASE_DIR/stop-reason"
  SUMMARY_FILE="$BASE_DIR/runtime-summary.json"
  METRICS_PATH="$BASE_DIR"
  SESSION_META="$BASE_DIR/session-metadata.json"
}

active_session() {
  if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    return 0
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(<"$PID_FILE")"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && return 0
  fi
  return 1
}

preflight() {
  require_data_root
  cd "$REPO_ROOT"
  sha256sum --check --strict "$HASH_REL"
  [[ "$(git branch --show-current)" == "batch/4b-r2-24-market-observation" ]] || {
    printf 'Wrong branch; expected batch/4b-r2-24-market-observation.\n' >&2
    exit 3
  }
  [[ -z "$(git status --porcelain=v1)" ]] || {
    printf 'Worktree must be clean before launch.\n' >&2
    git status --short >&2
    exit 3
  }
  [[ "${LIVE_TRADING_ENABLED:-false}" == "false" ]] || {
    printf 'LIVE_TRADING_ENABLED must be false.\n' >&2
    exit 3
  }
  mkdir -p -- "$DATA_ROOT"
  local fstype free_bytes
  fstype="$(findmnt -T "$DATA_ROOT" -n -o FSTYPE)"
  case "${fstype,,}" in
    9p|drvfs|ntfs|ntfs3|fuseblk)
      printf 'POLY_DATA_ROOT is not Linux-native: %s (%s)\n' "$DATA_ROOT" "$fstype" >&2
      exit 3
      ;;
  esac
  free_bytes="$(df -PB1 --output=avail "$DATA_ROOT" | tail -n 1 | tr -d ' ')"
  [[ "$free_bytes" =~ ^[0-9]+$ ]] && (( free_bytes >= MIN_FREE_BYTES )) || {
    printf 'Free disk is below the frozen 10 GiB gate: %s bytes.\n' "$free_bytes" >&2
    exit 3
  }
  if active_session; then
    printf 'An R2 session is already active; refusing a second session.\n' >&2
    exit 4
  fi
  printf 'preflight=PASS\nbranch=%s\nhead=%s\nconfig_sha256=%s\nfilesystem=%s\nfree_bytes=%s\n' \
    "$(git branch --show-current)" "$(git rev-parse HEAD)" "$(cut -d' ' -f1 "$HASH_REL")" "$fstype" "$free_bytes"
}

run_child() {
  require_data_root
  cd "$REPO_ROOT"
  local exit_code=0 stop_reason="MAXIMUM_RUNTIME_150_MINUTES_REACHED"
  trap 'stop_reason="MANUAL_GRACEFUL_STOP"' TERM INT
  (
    while :; do
      date -u +%Y-%m-%dT%H:%M:%SZ > "$HEARTBEAT_FILE"
      sleep 5
    done
  ) &
  local heartbeat_pid=$!
  set +e
  node --use-env-proxy dist/scripts/live-runtime.js paper \
    --duration-seconds "$MAXIMUM_RUNTIME_SECONDS" \
    --record metrics \
    --output "$METRICS_PATH" \
    --summary "$SUMMARY_FILE" \
    --git-commit "$(git rev-parse HEAD)" \
    --experiment-config "$CONFIG_PATH" \
    --json
  exit_code=$?
  set -e
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true
  if (( exit_code != 0 )); then stop_reason="RUNTIME_NONZERO_EXIT"; fi
  printf '%s\n' "$exit_code" > "$EXIT_FILE"
  printf '%s\n' "$stop_reason" > "$STOP_REASON_FILE"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$HEARTBEAT_FILE"
  exit "$exit_code"
}

launch() {
  preflight >/dev/null
  require_data_root
  mkdir -p -m 700 -- "$BASE_DIR"
  local session_id started_at head config_hash
  session_id="r2-$(date -u +%Y%m%dT%H%M%SZ)"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  config_hash="$(cut -d' ' -f1 "$REPO_ROOT/$HASH_REL")"
  printf '%s\n' "$session_id" > "$SESSION_ID_FILE"
  printf '{\n  "session_id": "%s",\n  "git_commit": "%s",\n  "config_sha256": "%s",\n  "start_time": "%s",\n  "metrics_path": "%s",\n  "report_path": "%s"\n}\n' \
    "$session_id" "$head" "$config_hash" "$started_at" "$SUMMARY_FILE" \
    "$REPO_ROOT/reports/batches/batch-04b-r2" > "$SESSION_META"
  npm run build
  if systemctl --user show-environment >/dev/null 2>&1; then
    printf 'systemd-user\n' > "$RUNNER_FILE"
    systemd-run --user --unit="$UNIT" --collect \
      --property="WorkingDirectory=$REPO_ROOT" \
      --property="StandardOutput=append:$STDOUT_FILE" \
      --property="StandardError=append:$STDERR_FILE" \
      --setenv="POLY_DATA_ROOT=$DATA_ROOT" \
      "$REPO_ROOT/scripts/batch-04b-r2-session.sh" _run
    systemctl --user show "$UNIT" -p MainPID --value > "$PID_FILE"
  else
    printf 'nohup-setsid\n' > "$RUNNER_FILE"
    setsid nohup env POLY_DATA_ROOT="$DATA_ROOT" \
      "$REPO_ROOT/scripts/batch-04b-r2-session.sh" _run \
      >>"$STDOUT_FILE" 2>>"$STDERR_FILE" </dev/null &
    printf '%s\n' "$!" > "$PID_FILE"
  fi
  printf 'launched session=%s pid=%s runner=%s\n' "$session_id" "$(<"$PID_FILE")" "$(<"$RUNNER_FILE")"
}

status() {
  require_data_root
  if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    systemctl --user show "$UNIT" -p ActiveState -p SubState -p MainPID -p ExecMainStatus
  elif [[ -f "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null; then
    printf 'ActiveState=active\nSubState=running\nMainPID=%s\n' "$(<"$PID_FILE")"
  else
    printf 'ActiveState=inactive\n'
  fi
  [[ -f "$SESSION_META" ]] && printf 'metadata=%s\n' "$SESSION_META"
  [[ -f "$HEARTBEAT_FILE" ]] && printf 'heartbeat=%s\n' "$(<"$HEARTBEAT_FILE")"
  [[ -f "$EXIT_FILE" ]] && printf 'exit_status=%s\n' "$(<"$EXIT_FILE")"
  [[ -f "$STOP_REASON_FILE" ]] && printf 'stop_reason=%s\n' "$(<"$STOP_REASON_FILE")"
}

logs() {
  require_data_root
  printf '%s\n' '--- stdout ---'
  [[ -f "$STDOUT_FILE" ]] && tail -n 80 "$STDOUT_FILE" || true
  printf '%s\n' '--- stderr ---'
  [[ -f "$STDERR_FILE" ]] && tail -n 80 "$STDERR_FILE" || true
}

stop() {
  require_data_root
  if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    systemctl --user kill --signal=SIGTERM "$UNIT"
  elif [[ -f "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null; then
    kill -TERM "$(<"$PID_FILE")"
  else
    printf 'No active R2 session.\n'
  fi
}

command="${1:-}"
case "$command" in
  preflight) preflight ;;
  launch) launch ;;
  status) status ;;
  logs) logs ;;
  stop) stop ;;
  _run) run_child ;;
  *) usage; exit 2 ;;
esac
