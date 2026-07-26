#!/usr/bin/env bash
# common.sh — shared helpers for the Cloudflare zone automation scripts.
# Sourced by setup-zone.sh and verify-zone.sh; not meant to run standalone.

CF_API_BASE="https://api.cloudflare.com/client/v4"

CACHE_BYPASS_DESCRIPTION="eveai: bypass cache for web API and auth paths"
RATE_LIMIT_DESCRIPTION="eveai: challenge bursts on auth endpoints"

# Free plan limits relevant to this automation.
CACHE_RULES_LIMIT=10
RATE_LIMIT_RULES_LIMIT=1

require_command() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '${cmd}' is required but not installed." >&2
    echo "hint:  ${hint}" >&2
    exit 1
  fi
}

check_prerequisites() {
  require_command curl "install with: brew install curl (macOS) or apt-get install curl (Debian/Ubuntu)"
  require_command jq "install with: brew install jq (macOS) or apt-get install jq (Debian/Ubuntu)"
  if [[ -z "${CF_API_TOKEN:-}" ]]; then
    echo "error: CF_API_TOKEN is not set." >&2
    echo "hint:  create a scoped API token (see docs/deployment.md, 'Cloudflare Zone Automation')" >&2
    echo "       and export it: export CF_API_TOKEN=..." >&2
    exit 1
  fi
}

# cf_api METHOD PATH [JSON_BODY]
# Prints the raw response body on stdout. Transport failures abort via set -e;
# callers must inspect the JSON "success" flag for API-level errors.
cf_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(
    --silent --show-error
    --request "${method}"
    --header "Authorization: Bearer ${CF_API_TOKEN}"
    --header "Content-Type: application/json"
    "${CF_API_BASE}${path}"
  )
  if [[ -n "${body}" ]]; then
    args+=(--data "${body}")
  fi
  curl "${args[@]}"
}

# Prints the zone id on stdout. Uses CF_ZONE_ID when set, otherwise resolves
# CF_ZONE_NAME through the API (requires exactly one active zone match).
resolve_zone_id() {
  if [[ -n "${CF_ZONE_ID:-}" ]]; then
    echo "${CF_ZONE_ID}"
    return 0
  fi
  if [[ -z "${CF_ZONE_NAME:-}" ]]; then
    echo "error: set CF_ZONE_NAME (e.g. export CF_ZONE_NAME=example.com) or CF_ZONE_ID." >&2
    exit 1
  fi
  local response count
  response=$(cf_api GET "/zones?name=${CF_ZONE_NAME}&status=active")
  count=$(jq -r 'if .success then (.result | length) else -1 end' <<<"${response}")
  if [[ "${count}" != "1" ]]; then
    echo "error: expected exactly one active zone named '${CF_ZONE_NAME}', got ${count}." >&2
    echo "hint:  check the token has Zone:Read for this zone, or set CF_ZONE_ID directly." >&2
    exit 1
  fi
  jq -r '.result[0].id' <<<"${response}"
}

# get_setting ZONE_ID NAME -> current value (empty on failure)
get_setting() {
  local zone_id="$1" name="$2" response
  response=$(cf_api GET "/zones/${zone_id}/settings/${name}")
  jq -r 'if .success then .result.value else empty end' <<<"${response}"
}

# ensure_setting ZONE_ID NAME DESIRED — PATCHes only when the value differs.
ensure_setting() {
  local zone_id="$1" name="$2" desired="$3" current response
  current=$(get_setting "${zone_id}" "${name}")
  if [[ "${current}" == "${desired}" ]]; then
    echo "ok:      setting '${name}' already '${desired}'"
    return 0
  fi
  response=$(cf_api PATCH "/zones/${zone_id}/settings/${name}" "{\"value\":\"${desired}\"}")
  if jq -e '.success == true' <<<"${response}" >/dev/null; then
    echo "updated: setting '${name}' '${current:-unknown}' -> '${desired}'"
  else
    echo "error: failed to set '${name}': $(jq -c '.errors' <<<"${response}")" >&2
    return 1
  fi
}

# get_entrypoint_rules ZONE_ID PHASE -> rules JSON array (empty array when the
# ruleset does not exist yet or cannot be read)
get_entrypoint_rules() {
  local zone_id="$1" phase="$2" response
  response=$(cf_api GET "/zones/${zone_id}/rulesets/phases/${phase}/entrypoint")
  if jq -e '.success == true' <<<"${response}" >/dev/null; then
    jq -c '.result.rules // []' <<<"${response}"
  else
    echo '[]'
  fi
}

# put_entrypoint_rules ZONE_ID PHASE RULES_JSON — replaces the whole entrypoint
# ruleset atomically with the given rules array.
put_entrypoint_rules() {
  local zone_id="$1" phase="$2" rules="$3" response
  response=$(cf_api PUT "/zones/${zone_id}/rulesets/phases/${phase}/entrypoint" \
    "$(jq -nc --argjson rules "${rules}" '{name: "default", rules: $rules}')")
  if jq -e '.success == true' <<<"${response}" >/dev/null; then
    return 0
  fi
  echo "error: failed to update '${phase}' ruleset: $(jq -c '.errors' <<<"${response}")" >&2
  return 1
}

# rule_status RULES_JSON DESIRED_JSON -> absent|same|different
# Matches our rule by its description marker; "same" means every key of the
# desired rule is deep-equal in the stored rule (extra stored keys are ignored).
rule_status() {
  jq -r --argjson want "$2" '
    ([.[] | select(.description == $want.description)] | first) as $cur
    | if $cur == null then "absent"
      elif all($want | to_entries[]; .value == $cur[.key]) then "same"
      else "different" end' <<<"$1"
}

# Desired rule payloads (single source of truth for setup and verify).
cache_bypass_rule_json() {
  jq -nc --arg description "${CACHE_BYPASS_DESCRIPTION}" '{
    description: $description,
    # starts_with() instead of the regex `matches` operator: `matches` requires a
    # Business/Enterprise plan (not entitled on Free). Prefix semantics identical.
    expression: "(starts_with(http.request.uri.path, \"/api/web/\")) or (starts_with(http.request.uri.path, \"/auth/\"))",
    action: "set_cache_settings",
    action_parameters: {cache: false},
    enabled: true
  }'
}

rate_limit_rule_json() {
  local action="${1:-managed_challenge}"
  # Free plan constraints for the http_ratelimit phase (see
  # https://developers.cloudflare.com/waf/rate-limiting-rules/):
  #   - characteristics: only IP tracking; cf.colo.id is mandatory on all plans
  #     and ip.src is the IP characteristic, so both are allowed on Free.
  #   - period: 10 s is the only counting period available on Free.
  #   - mitigation_timeout: 10 s is the only value Free is entitled to; the API
  #     rejects anything else ("not entitled to use a mitigation timeout
  #     different from 10").
  #   - expression: only Path and Verified Bot fields are available on Free;
  #     starts_with(http.request.uri.path, ...) is fine.
  #   - counting_expression (custom counting) is not available on Free and is
  #     intentionally not set.
  # Consequence: the mitigation window is 10 s, not the 60 s originally wanted.
  jq -nc --arg description "${RATE_LIMIT_DESCRIPTION}" --arg action "${action}" '{
    description: $description,
    expression: "starts_with(http.request.uri.path, \"/auth/\")",
    action: $action,
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requests_per_period: 20,
      mitigation_timeout: 10
    },
    enabled: true
  }'
}
