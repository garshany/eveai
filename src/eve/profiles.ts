/**
 * ocli profile definitions.
 *
 * 10 profiles covering all major ESI categories.
 * Profiles are registered with openapi-to-cli via `npm run ocli:setup`.
 *
 * ESI base URL: https://esi.evetech.net/latest
 * ESI spec: https://esi.evetech.net/latest/swagger.json
 * ~195 endpoints total (76 public, 119 authenticated)
 */

export interface OcliProfile {
  name: string;
  description: string;
  requiresAuth: boolean;
  /** Minimum required scopes -- if empty, profile is public */
  requiredScopes: string[];
}

export const PROFILES: OcliProfile[] = [
  {
    name: 'eve-public',
    description: 'Public ESI: universe, status, routes, dogma, insurance, sovereignty, wars, alliances, public contracts, public industry, loyalty stores',
    requiresAuth: false,
    requiredScopes: [],
  },
  {
    name: 'eve-character',
    description: 'Character: sheet, location, skills, skillqueue, implants, clones, contacts, standings, fittings, killmails, notifications, bookmarks, roles, search',
    requiresAuth: true,
    requiredScopes: [
      'esi-skills.read_skills.v1',
      'esi-skills.read_skillqueue.v1',
      'esi-clones.read_clones.v1',
      'esi-clones.read_implants.v1',
      'esi-location.read_location.v1',
      'esi-location.read_ship_type.v1',
      'esi-location.read_online.v1',
      'esi-characters.read_contacts.v1',
      'esi-characters.read_standings.v1',
      'esi-characters.read_notifications.v1',
      'esi-fittings.read_fittings.v1',
      'esi-killmails.read_killmails.v1',
      'esi-bookmarks.read_character_bookmarks.v1',
    ],
  },
  {
    name: 'eve-wallet',
    description: 'Wallet: balance, journal, transactions',
    requiresAuth: true,
    requiredScopes: [
      'esi-wallet.read_character_wallet.v1',
    ],
  },
  {
    name: 'eve-assets',
    description: 'Assets: list, locations, names',
    requiresAuth: true,
    requiredScopes: [
      'esi-assets.read_assets.v1',
    ],
  },
  {
    name: 'eve-market',
    description: 'Market: regional history/orders/types, market prices/groups, character orders',
    requiresAuth: true,
    requiredScopes: [
      'esi-markets.read_character_orders.v1',
    ],
  },
  {
    name: 'eve-industry',
    description: 'Industry: character jobs, blueprints, mining, planetary interaction, public industry facilities/systems',
    requiresAuth: true,
    requiredScopes: [
      'esi-industry.read_character_jobs.v1',
      'esi-characters.read_blueprints.v1',
      'esi-planets.manage_planets.v1',
    ],
  },
  {
    name: 'eve-contracts',
    description: 'Contracts: character contracts with bids/items, public contracts by region',
    requiresAuth: true,
    requiredScopes: [
      'esi-contracts.read_character_contracts.v1',
    ],
  },
  {
    name: 'eve-mail',
    description: 'Mail: read mail, labels, mailing lists',
    requiresAuth: true,
    requiredScopes: [
      'esi-mail.read_mail.v1',
    ],
  },
  {
    name: 'eve-corp',
    description: 'Corporation: members, roles, structures, starbases, wallets, assets, contracts, industry, blueprints, contacts, standings',
    requiresAuth: true,
    requiredScopes: [
      'esi-corporations.read_corporation_membership.v1',
      'esi-corporations.read_structures.v1',
      'esi-wallet.read_corporation_wallets.v1',
      'esi-assets.read_corporation_assets.v1',
    ],
  },
  {
    name: 'eve-ui',
    description: 'UI: autopilot waypoints, open windows (contract, info, market, newmail)',
    requiresAuth: true,
    requiredScopes: [
      'esi-ui.open_window.v1',
      'esi-ui.write_waypoint.v1',
    ],
  },
];

export function getProfile(name: string): OcliProfile | undefined {
  return PROFILES.find((p) => p.name === name);
}

export const PROFILE_NAMES = PROFILES.map((p) => p.name);
