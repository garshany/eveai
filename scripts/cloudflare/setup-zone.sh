#!/usr/bin/env bash
# setup-zone.sh — idempotent post-deploy Cloudflare zone hardening for the
# browser-chat deployment behind Cloudflare Tunnel (hostname -> http://localhost:3000).
#
# Applies, via Cloudflare API v4:
#   - SSL/TLS mode: Full (strict)
#   - Always Use HTTPS: on
#   - Security level: medium
#   - Bot Fight Mode: enabled (Free plan feature)
#   - Cache Rules: bypass cache for /api/web/* and /auth/*
#   - Rate Limiting: 20 requests / 10 s per IP on /auth/*, managed_challenge,
#     mitigation timeout 10 s (the only value the Free plan allows)
#
# Required env:
#   CF_API_TOKEN   scoped API token (see docs/deployment.md, "Cloudflare Zone Automation")
#   CF_ZONE_NAME   zone name (e.g. example.com) — or set CF_ZONE_ID directly
# Optional env:
#   CF_ZONE_ID             skip the zone-name lookup
#   CF_RATE_LIMIT_ACTION   managed_challenge (default) | block
#
# Idempotent: rules are matched by their description marker and updated in
# place, never duplicated. Re-run any time to converge the zone.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/cloudflare/common.sh
source "${SCRIPT_DIR}/common.sh"

RATE_LIMIT_ACTION="${CF_RATE_LIMIT_ACTION:-managed_challenge}"

ensure_rule() {
  # ensure_rule ZONE_ID PHASE DESIRED_RULE_JSON LIMIT
  local zone_id="$1" phase="$2" desired="$3" limit="$4"
  local description rules status
  description=$(jq -r '.description' <<<"${desired}")
  rules=$(get_entrypoint_rules "${zone_id}" "${phase}")
  status=$(rule_status "${rules}" "${desired}")
  case "${status}" in
    same)
      echo "ok:      rule '${description}' already up to date (${phase})"
      return 0
      ;;
    different)
      echo "update:  rule '${description}' drifted, rewriting in place (${phase})"
      ;;
    absent)
      local total
      total=$(jq 'length' <<<"${rules}")
      if [[ "${total}" -ge "${limit}" ]]; then
        echo "error: '${phase}' already has ${total} rule(s); Free plan allows ${limit}." >&2
        echo "hint:  remove an existing rule in the dashboard, then re-run." >&2
        return 1
      fi
      echo "create:  rule '${description}' (${phase})"
      ;;
  esac
  local kept updated
  # Drop previous copies of our rule and API-computed metadata, keep the rest.
  kept=$(jq -c --arg d "${description}" \
    '[.[] | select(.description != $d) | del(.version, .last_updated)]' <<<"${rules}")
  updated=$(jq -c --argjson desired "${desired}" '. + [$desired]' <<<"${kept}")
  put_entrypoint_rules "${zone_id}" "${phase}" "${updated}"
  echo "done:    rule '${description}' applied (${phase})"
}

ensure_bot_fight_mode() {
  local zone_id="$1" response current
  # Bot Fight Mode is managed via the Bot Management config endpoint
  # (GET/PUT /zones/{id}/bot_management, field fight_mode). The standalone
  # /zones/{id}/bot_fight_mode route does not exist (API error 7000).
  response=$(cf_api GET "/zones/${zone_id}/bot_management")
  if ! jq -e '.success == true' <<<"${response}" >/dev/null; then
    echo "warning: cannot read Bot Fight Mode state: $(jq -c '.errors' <<<"${response}")" >&2
    echo "warning: enable it manually: dashboard -> Security -> Bots -> Bot Fight Mode." >&2
    return 0
  fi
  current=$(jq -r '.result.fight_mode' <<<"${response}")
  if [[ "${current}" == "true" ]]; then
    echo "ok:      Bot Fight Mode already enabled"
    return 0
  fi
  response=$(cf_api PUT "/zones/${zone_id}/bot_management" '{"fight_mode":true}')
  if jq -e '.success == true' <<<"${response}" >/dev/null; then
    echo "updated: Bot Fight Mode enabled"
  else
    echo "warning: cannot enable Bot Fight Mode: $(jq -c '.errors' <<<"${response}")" >&2
    echo "warning: enable it manually: dashboard -> Security -> Bots -> Bot Fight Mode." >&2
  fi
}

main() {
  check_prerequisites
  case "${RATE_LIMIT_ACTION}" in
    managed_challenge|block) ;;
    *)
      echo "error: CF_RATE_LIMIT_ACTION must be 'managed_challenge' or 'block', got '${RATE_LIMIT_ACTION}'." >&2
      exit 1
      ;;
  esac

  local zone_id
  zone_id=$(resolve_zone_id)
  echo "Zone id: ${zone_id}"
  echo

  echo "== Zone settings =="
  ensure_setting "${zone_id}" ssl strict
  ensure_setting "${zone_id}" always_use_https on
  ensure_setting "${zone_id}" security_level medium
  echo

  echo "== Bots =="
  ensure_bot_fight_mode "${zone_id}"
  echo

  echo "== Cache Rules (phase http_request_cache_settings) =="
  ensure_rule "${zone_id}" http_request_cache_settings "$(cache_bypass_rule_json)" "${CACHE_RULES_LIMIT}"
  echo

  echo "== Rate Limiting (phase http_ratelimit) =="
  ensure_rule "${zone_id}" http_ratelimit "$(rate_limit_rule_json "${RATE_LIMIT_ACTION}")" "${RATE_LIMIT_RULES_LIMIT}"
  echo

  echo "Zone setup complete. Run scripts/cloudflare/verify-zone.sh to audit."
}

main "$@"
