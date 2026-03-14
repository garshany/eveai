/**
 * All EVE SSO scopes requested by our profiles.
 * Every scope here maps to at least one profile in profiles.ts.
 *
 * Full scope reference: https://developers.eveonline.com/docs/services/sso/
 */
export const ALL_REQUESTED_SCOPES = [
  // eve-character
  'esi-skills.read_skills.v1',
  'esi-skills.read_skillqueue.v1',
  'esi-clones.read_clones.v1',
  'esi-clones.read_implants.v1',
  'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1',
  'esi-location.read_online.v1',
  'esi-characters.read_contacts.v1',
  'esi-characters.read_loyalty.v1',
  'esi-characters.read_standings.v1',
  'esi-characters.read_titles.v1',
  'esi-characters.read_medals.v1',
  'esi-characters.read_fatigue.v1',
  'esi-characters.read_notifications.v1',
  'esi-characters.read_agents_research.v1',
  'esi-bookmarks.read_character_bookmarks.v1',
  'esi-fittings.read_fittings.v1',
  'esi-fittings.write_fittings.v1',
  'esi-killmails.read_killmails.v1',
  'esi-characters.read_corporation_roles.v1',
  // eve-wallet
  'esi-wallet.read_character_wallet.v1',
  // eve-assets
  'esi-assets.read_assets.v1',
  // eve-market (character orders)
  'esi-markets.read_character_orders.v1',
  // eve-industry
  'esi-industry.read_character_jobs.v1',
  'esi-characters.read_blueprints.v1',
  'esi-planets.manage_planets.v1',
  'esi-industry.read_character_mining.v1',
  // eve-contracts
  'esi-contracts.read_character_contracts.v1',
  // eve-mail
  'esi-mail.read_mail.v1',
  // eve-corp
  'esi-corporations.read_corporation_membership.v1',
  'esi-corporations.read_structures.v1',
  'esi-corporations.read_starbases.v1',
  'esi-corporations.read_blueprints.v1',
  'esi-corporations.read_contacts.v1',
  'esi-corporations.read_container_logs.v1',
  'esi-corporations.read_contracts.v1',
  'esi-corporations.read_divisions.v1',
  'esi-corporations.read_facilities.v1',
  'esi-corporations.read_medals.v1',
  'esi-corporations.read_standings.v1',
  'esi-corporations.read_titles.v1',
  'esi-wallet.read_corporation_wallets.v1',
  'esi-assets.read_corporation_assets.v1',
  'esi-industry.read_corporation_jobs.v1',
  'esi-markets.read_corporation_orders.v1',
  'esi-killmails.read_corporation_killmails.v1',
  'esi-corporations.read_fw_stats.v1',
  'esi-corporations.track_members.v1',
  // eve-fleet
  'esi-fleets.read_fleet.v1',
  'esi-fleets.write_fleet.v1',
  // eve-ui
  'esi-ui.open_window.v1',
  'esi-ui.write_waypoint.v1',
  // eve-calendar
  'esi-calendar.read_calendar_events.v1',
];
