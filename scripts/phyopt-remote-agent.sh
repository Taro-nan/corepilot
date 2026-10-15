#!/usr/bin/env bash
# PhyOpt remote job helper (POSIX shell, no network service required).
# Install this file as `phyopt-remote-agent` on the target ARM host. It owns a
# per-job process group and durable state so closing SSH never masquerades as a
# confirmed remote stop.
set -u

STATE_DIR="${HOME}/.phyopt/remote-jobs"
COMMAND="${1:-}"
shift || true
JOB_ID=""
REQUEST_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --job-id) JOB_ID="${2:-}"; shift 2 ;;
    --request-id) REQUEST_ID="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done

if [ -z "$JOB_ID" ] || ! printf '%s' "$JOB_ID" | grep -Eq '^[A-Za-z0-9_.:-]+$'; then
  printf '%s\n' '{"accepted":false,"state":"UNKNOWN","error":"invalid job id"}'
  exit 2
fi

JOB_DIR="${STATE_DIR}/${JOB_ID}"
STATE_FILE="${JOB_DIR}/state"
PID_FILE="${JOB_DIR}/pid"
PGID_FILE="${JOB_DIR}/pgid"
EXIT_FILE="${JOB_DIR}/exit_code"
STOP_FILE="${JOB_DIR}/stop.requested"
OUT_FILE="${JOB_DIR}/stdout.log"
ERR_FILE="${JOB_DIR}/stderr.log"

json_status() {
  state="$1"
  exit_code="null"
  if [ -f "$EXIT_FILE" ]; then exit_code="$(cat "$EXIT_FILE")"; fi
  printf '{"protocol_version":"1","remote_job_id":"%s","state":"%s","exit_code":%s}\n' "$JOB_ID" "$state" "$exit_code"
}

read_state() {
  if [ ! -f "$STATE_FILE" ]; then printf '%s' 'NOT_FOUND'; return; fi
  cat "$STATE_FILE"
}

group_alive() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  # A job is running while any member of its dedicated process group exists.
  # Checking the group (rather than only the leader PID) prevents stop from
  # claiming success while a child/grandchild is still alive.
  kill -0 -- "-$1" 2>/dev/null
}

case "$COMMAND" in
  run)
    mkdir -p "$JOB_DIR" || { printf '%s\n' '{"accepted":false,"state":"UNKNOWN","error":"state directory unavailable"}' >&2; exit 125; }
    existing="$(read_state)"
    if [ "$existing" = "RUNNING" ] || [ "$existing" = "STOP_REQUESTED" ]; then
      printf '%s\n' '{"accepted":false,"state":"RUNNING","error":"job already exists"}' >&2
      exit 125
    fi
    : > "$OUT_FILE"
    : > "$ERR_FILE"
    rm -f "$STOP_FILE" "$EXIT_FILE"
    # Ignore HUP and create a new session/process group. The child survives if
    # the foreground SSH connection is killed by the client.
    trap '' HUP
    nohup setsid "$@" >"$OUT_FILE" 2>"$ERR_FILE" &
    pid=$!
    printf '%s\n' "$pid" > "$PID_FILE"
    printf '%s\n' "$pid" > "$PGID_FILE"
    printf '%s\n' 'RUNNING' > "$STATE_FILE"
    wait "$pid"
    rc=$?
    printf '%s\n' "$rc" > "$EXIT_FILE"
    if [ -f "$STOP_FILE" ]; then
      printf '%s\n' 'STOPPED' > "$STATE_FILE"
    elif [ "$rc" -eq 0 ]; then
      printf '%s\n' 'COMPLETED' > "$STATE_FILE"
    else
      printf '%s\n' 'FAILED' > "$STATE_FILE"
    fi
    cat "$OUT_FILE"
    cat "$ERR_FILE" >&2
    exit "$rc"
    ;;
  status)
    state="$(read_state)"
    if [ "$state" = "RUNNING" ] || [ "$state" = "STOP_REQUESTED" ]; then
      pid=""
      if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE")"; fi
      pgid=""
      if [ -f "$PGID_FILE" ]; then pgid="$(cat "$PGID_FILE")"; fi
      if [ -n "$pgid" ] && group_alive "$pgid"; then
        json_status "$state"
        exit 0
      fi
      if [ -f "$STOP_FILE" ]; then
        printf '%s\n' 'STOPPED' > "$STATE_FILE"
        state="STOPPED"
      elif [ -f "$EXIT_FILE" ]; then
        rc="$(cat "$EXIT_FILE")"
        if [ "$rc" -eq 0 ]; then state="COMPLETED"; else state="FAILED"; fi
        printf '%s\n' "$state" > "$STATE_FILE"
      else
        state="UNKNOWN"
      fi
    fi
    json_status "$state"
    ;;
  stop)
    mkdir -p "$JOB_DIR" 2>/dev/null || true
    state="$(read_state)"
    if [ "$state" = "NOT_FOUND" ]; then
      printf '%s\n' '{"accepted":true,"state":"NOT_FOUND"}'
      exit 0
    fi
    : > "$STOP_FILE"
    printf '%s\n' 'STOP_REQUESTED' > "$STATE_FILE"
    pgid=""
    if [ -f "$PGID_FILE" ]; then pgid="$(cat "$PGID_FILE")"; fi
    if [ -n "$pgid" ]; then kill -TERM -- -"$pgid" 2>/dev/null || true; fi
    i=0
    while [ "$i" -lt 30 ]; do
      if [ -z "$pgid" ] || ! group_alive "$pgid"; then break; fi
      sleep 0.1
      i=$((i + 1))
    done
    if [ -n "$pgid" ] && group_alive "$pgid"; then kill -KILL -- -"$pgid" 2>/dev/null || true; fi
    if [ -z "$pgid" ] || ! group_alive "$pgid"; then
      printf '%s\n' 'STOPPED' > "$STATE_FILE"
      printf '%s\n' '{"accepted":true,"state":"STOPPED"}'
    else
      printf '%s\n' '{"accepted":true,"state":"STOP_REQUESTED"}'
    fi
    ;;
  *)
    printf '%s\n' '{"accepted":false,"state":"UNKNOWN","error":"unsupported command"}'
    exit 2
    ;;
esac
