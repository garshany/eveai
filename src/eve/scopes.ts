/**
 * EVE SSO scopes requested by the agent.
 * Runtime access is enforced per generated ESI operation through
 * get_eve_capabilities and the native ESI client.
 *
 * Full scope reference: https://developers.eveonline.com/docs/services/sso/
 */
export const EVE_ACCESS_GROUPS = {
  navigation: [
    'esi-location.read_location.v1',
    'esi-location.read_ship_type.v1',
    'esi-location.read_online.v1',
    'esi-search.search_structures.v1',
  ],
  character: [
    'esi-skills.read_skills.v1',
    'esi-skills.read_skillqueue.v1',
    'esi-clones.read_clones.v1',
    'esi-clones.read_implants.v1',
    'esi-characters.read_contacts.v1',
    'esi-characters.read_loyalty.v1',
    'esi-characters.read_standings.v1',
    'esi-characters.read_titles.v1',
    'esi-characters.read_medals.v1',
    'esi-characters.read_fatigue.v1',
    'esi-characters.read_notifications.v1',
    'esi-characters.read_agents_research.v1',
    'esi-fittings.read_fittings.v1',
    'esi-killmails.read_killmails.v1',
    'esi-characters.read_corporation_roles.v1',
    'esi-fleets.read_fleet.v1',
  ],
  economy: [
    'esi-wallet.read_character_wallet.v1',
    'esi-assets.read_assets.v1',
    'esi-markets.read_character_orders.v1',
    'esi-markets.structure_markets.v1',
    'esi-industry.read_character_jobs.v1',
    'esi-characters.read_blueprints.v1',
    'esi-industry.read_character_mining.v1',
    'esi-contracts.read_character_contracts.v1',
  ],
  communications: [
    'esi-mail.read_mail.v1',
    'esi-calendar.read_calendar_events.v1',
  ],
  corporation: [
    'esi-corporations.read_corporation_membership.v1',
    'esi-corporations.read_structures.v1',
    'esi-corporations.read_starbases.v1',
    'esi-corporations.read_blueprints.v1',
    'esi-corporations.read_contacts.v1',
    'esi-corporations.read_container_logs.v1',
    'esi-contracts.read_corporation_contracts.v1',
    'esi-corporations.read_divisions.v1',
    'esi-corporations.read_facilities.v1',
    'esi-corporations.read_medals.v1',
    'esi-corporations.read_standings.v1',
    'esi-corporations.read_titles.v1',
    'esi-planets.read_customs_offices.v1',
    'esi-wallet.read_corporation_wallets.v1',
    'esi-assets.read_corporation_assets.v1',
    'esi-industry.read_corporation_jobs.v1',
    'esi-industry.read_corporation_mining.v1',
    'esi-markets.read_corporation_orders.v1',
    'esi-killmails.read_corporation_killmails.v1',
    'esi-corporations.read_fw_stats.v1',
    'esi-corporations.track_members.v1',
  ],
  actions: [
    'esi-fittings.write_fittings.v1',
    'esi-planets.manage_planets.v1',
    'esi-mail.organize_mail.v1',
    'esi-mail.send_mail.v1',
    'esi-fleets.write_fleet.v1',
    'esi-ui.open_window.v1',
    'esi-ui.write_waypoint.v1',
  ],
} as const;

export type EveAccessGroupId = keyof typeof EVE_ACCESS_GROUPS;

export const EVE_ACCESS_GROUP_IDS = Object.freeze(
  Object.keys(EVE_ACCESS_GROUPS) as EveAccessGroupId[],
);

export const DEFAULT_EVE_ACCESS_GROUPS = Object.freeze<EveAccessGroupId[]>(['navigation']);

export const ALL_REQUESTED_SCOPES = Object.freeze(
  EVE_ACCESS_GROUP_IDS.flatMap((groupId) => EVE_ACCESS_GROUPS[groupId]),
);

export function isEveAccessGroupId(value: string): value is EveAccessGroupId {
  return Object.hasOwn(EVE_ACCESS_GROUPS, value);
}

export function scopesForEveAccessGroups(groupIds: readonly EveAccessGroupId[]): string[] {
  return [...new Set(groupIds.flatMap((groupId) => EVE_ACCESS_GROUPS[groupId]))];
}
