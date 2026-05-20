#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

max_attempts="${PUFFER_AGENTFLOW_MAX_ATTEMPTS:-3}"
run_timeout="${PUFFER_AGENTFLOW_TIMEOUT_SECONDS:-2700}"
report_path="${PUFFER_AGENTFLOW_REPORT:-/tmp/puffer_agentflow_fuzz_report.md}"

if [[ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
  echo "ANTHROPIC_AUTH_TOKEN is required" >&2
  exit 2
fi

if [[ "${ANTHROPIC_BASE_URL:-}" != "https://api-infer.agentsey.ai" ]]; then
  echo "ANTHROPIC_BASE_URL must be https://api-infer.agentsey.ai" >&2
  exit 2
fi

cleanup_temp_specs() {
  find apps/puffer-desktop/tests -maxdepth 1 \
    \( -name '*tmp*.spec.ts' -o -name '*race.replay.spec.ts' \) -delete
}

report_is_stable() {
  [[ -s "$report_path" ]] || return 1
  grep -Eq 'confirmed|Confirmed|finding|Finding|coverage|Coverage|Shard outputs' "$report_path"
}

attempt=1
while (( attempt <= max_attempts )); do
  echo "== AgentFlow fuzz campaign attempt ${attempt}/${max_attempts} =="
  cleanup_temp_specs
  rm -f "$report_path"

  log_path="/tmp/puffer_agentflow_campaign_loop_attempt_${attempt}.log"
  set +e
  timeout --kill-after=30s "${run_timeout}s" \
    agentflow run fuzz/agentflow_puffer_campaign.py --output summary \
    >"$log_path" 2>&1
  status=$?
  set -e

  cleanup_temp_specs

  if [[ "$status" -eq 0 ]] && report_is_stable; then
    echo "Campaign completed with stable report: $report_path"
    echo "Attempt log: $log_path"
    exit 0
  fi

  echo "Attempt ${attempt} did not produce a stable report (exit ${status}). Log: ${log_path}" >&2
  attempt=$((attempt + 1))
done

echo "No stable campaign report after ${max_attempts} attempts" >&2
exit 1
