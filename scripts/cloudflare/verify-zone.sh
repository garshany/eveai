#!/usr/bin/env bash
# verify-zone.sh — read-only audit of the Cloudflare zone state applied by
# setup-zone.sh. Prints current values, compares them with the expected
# post-deploy configuration, and exits 1 when anything has drifted.
#
# Required env: CF_API_TOKEN plus CF_ZONE_NAME (or CF_ZONE_ID) — same as
# setup-zone.sh. Optional: CF_RATE_LIMIT_ACTION (default managed_challenge).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/cloudflare/common.sh
source "${SCRIPT_DIR}/common.sh"

RATE_LIMIT_ACTION="${CF_RATE_LIMIT_ACTION:-managed_challenge}"
FAILURES=0

expect_setting() {
  local name="$1" expected="$2" current
  current=$(get_setting "${ZONE_ID}" "${name}")
  if [[ "${current}" == "${expected}" ]]; then
    echo "  ok    ${name} = ${current}"
  else
    echo "  DRIFT ${name} = ${current:-<unreadable>} (expected: ${expected})"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_rule() {
  # expect_rule PHASE DESIRED_RULE_JSON LIMIT
  local phase="$1" desired="$2" limit="$3"
  local description rules status count
  description=$(jq -r '.description' <<<"${desired}")
  rules=$(get_entrypoint_rules "${ZONE_ID}" "${phase}")
  count=$(jq 'length' <<<"${rules}")
  status=$(rule_status "${rules}" "${desired}")
  echo "  info  ${phase}: ${count} rule(s) configured (Free plan limit: ${limit})"
  case "${status}" in
    same)
      echo "  ok    rule '${description}' present and matches expected"
      ;;
    different)
      echo "  DRIFT rule '${description}' present but differs from expected"
      FAILURES=$((FAILURES + 1))
      ;;
    absent)
      echo "  DRIFT rule '${description}' missing"
      FAILURES=$((FAILURES + 1))
      ;;
  esac
}

verify_bot_fight_mode() {
  local response
  response=$(cf_api GET "/zones/${ZONE_ID}/bot_management")
  if ! jq -e '.success == true' <<<"${response}" >/dev/null; then
    echo "  warn  Bot Fight Mode state unreadable with this token: $(jq -c '.errors' <<<"${response}")"
    return 0
  fi
  local current
  current=$(jq -r '.result.fight_mode' <<<"${response}")
  if [[ "${current}" == "true" ]]; then
    echo "  ok    fight_mode = true"
  else
    echo "  DRIFT fight_mode = ${current} (expected: true)"
    FAILURES=$((FAILURES + 1))
  fi
}

main() {
  check_prerequisites
  ZONE_ID=$(resolve_zone_id)
  echo "Zone id: ${ZONE_ID}"
  echo

  echo "== Zone settings =="
  expect_setting ssl strict
  expect_setting always_use_https on
  expect_setting security_level medium
  echo

  echo "== Bots =="
  verify_bot_fight_mode
  echo

  echo "== Cache Rules =="
  expect_rule http_request_cache_settings "$(cache_bypass_rule_json)" "${CACHE_RULES_LIMIT}"
  echo

  echo "== Rate Limiting =="
  expect_rule http_ratelimit "$(rate_limit_rule_json "${RATE_LIMIT_ACTION}")" "${RATE_LIMIT_RULES_LIMIT}"
  echo

  if [[ "${FAILURES}" -gt 0 ]]; then
    echo "FAILED: ${FAILURES} drift(s) detected. Re-run scripts/cloudflare/setup-zone.sh to converge."
    exit 1
  fi
  echo "OK: zone matches the expected post-deploy configuration."
}

main "$@"
