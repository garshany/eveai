/**
 * ocli-setup.ts -- Registers all 10 EVE ESI profiles in openapi-to-cli.
 *
 * Usage: npm run ocli:setup
 *
 * Real ocli onboard syntax (openapi-to-cli v0.1.8):
 *   npx openapi-to-cli onboard \
 *     --api-base-url https://esi.evetech.net/latest \
 *     --openapi-spec https://esi.evetech.net/latest/swagger.json \
 *     --profile <name> \
 *     --include-endpoints "GET:/universe/*,POST:/universe/ids/*" \
 *     --custom-headers '{"User-Agent":"...","X-Compatibility-Date":"..."}'
 */

import { execFileSync } from 'node:child_process';

const ESI_BASE_URL = 'https://esi.evetech.net/latest';
const ESI_SPEC_URL = 'https://esi.evetech.net/latest/swagger.json';
const USER_AGENT = 'eve-agent/0.1.0';
const COMPAT_DATE = '2026-03-14';

interface ProfileDef {
  name: string;
  description: string;
  endpoints: string;
}

/**
 * 10 profiles covering ~180 of ~195 ESI endpoints.
 * Patterns use METHOD:/path/* format.
 */
const PROFILES: ProfileDef[] = [
  {
    name: 'eve-public',
    description: 'Public ESI: universe, status, routes, dogma, alliances, wars, sovereignty, insurance, incursions, public industry, loyalty stores, public contracts',
    endpoints: [
      // Universe (31 endpoints) -- includes critical POST endpoints for name/ID resolution
      'GET:/universe/*',
      'POST:/universe/ids/*',
      'POST:/universe/names/*',
      // Server status
      'GET:/status/*',
      // Route planning
      'GET:/route/*',
      // Dogma (attributes, effects)
      'GET:/dogma/*',
      // Alliances
      'GET:/alliances/*',
      // Wars & killmails
      'GET:/wars/*',
      'GET:/killmails/*',
      // Sovereignty
      'GET:/sovereignty/*',
      // Insurance
      'GET:/insurance/prices/*',
      // Incursions
      'GET:/incursions/*',
      // Public industry data
      'GET:/industry/facilities/*',
      'GET:/industry/systems/*',
      // Loyalty stores
      'GET:/loyalty/stores/*',
      // Faction warfare
      'GET:/fw/*',
      // Public contracts
      'GET:/contracts/public/*',
      // Market (all public market endpoints)
      'GET:/markets/prices/*',
      'GET:/markets/groups/*',
      'GET:/markets/groups/{market_group_id}/*',
      'GET:/markets/{region_id}/history/*',
      'GET:/markets/{region_id}/orders/*',
      'GET:/markets/{region_id}/types/*',
      // Character public info (no auth needed)
      'POST:/characters/affiliation/*',
      'GET:/characters/{character_id}/corporationhistory/*',
      'GET:/characters/{character_id}/portrait/*',
    ].join(','),
  },
  {
    name: 'eve-character',
    description: 'Character: info, skills, location, clones, contacts, standings, fittings, killmails, notifications, bookmarks, roles, search',
    endpoints: [
      // Base character info
      'GET:/characters/{character_id}/*',
      // Skills
      'GET:/characters/{character_id}/skills/*',
      'GET:/characters/{character_id}/skillqueue/*',
      'GET:/characters/{character_id}/attributes/*',
      // Clones & implants
      'GET:/characters/{character_id}/clones/*',
      'GET:/characters/{character_id}/implants/*',
      // Location
      'GET:/characters/{character_id}/location/*',
      'GET:/characters/{character_id}/ship/*',
      'GET:/characters/{character_id}/online/*',
      'GET:/characters/{character_id}/fleet/*',
      // Social
      'GET:/characters/{character_id}/contacts/*',
      'GET:/characters/{character_id}/contacts/labels/*',
      'GET:/characters/{character_id}/standings/*',
      // Fittings
      'GET:/characters/{character_id}/fittings/*',
      'POST:/characters/{character_id}/fittings/*',
      'DELETE:/characters/{character_id}/fittings/*',
      // Misc
      'GET:/characters/{character_id}/medals/*',
      'GET:/characters/{character_id}/titles/*',
      'GET:/characters/{character_id}/fatigue/*',
      'GET:/characters/{character_id}/loyalty/points/*',
      'GET:/characters/{character_id}/agents_research/*',
      'GET:/characters/{character_id}/roles/*',
      // Notifications
      'GET:/characters/{character_id}/notifications/*',
      'GET:/characters/{character_id}/notifications/contacts/*',
      // Bookmarks
      'GET:/characters/{character_id}/bookmarks/*',
      'GET:/characters/{character_id}/bookmarks/folders/*',
      // Killmails
      'GET:/characters/{character_id}/killmails/recent/*',
      // Search (the ONLY search endpoint in current ESI)
      'GET:/characters/{character_id}/search/*',
      // Calendar
      'GET:/characters/{character_id}/calendar/*',
    ].join(','),
  },
  {
    name: 'eve-wallet',
    description: 'Wallet: balance, journal, transactions',
    endpoints: [
      'GET:/characters/{character_id}/wallet/*',
      'GET:/characters/{character_id}/wallet/journal/*',
      'GET:/characters/{character_id}/wallet/transactions/*',
    ].join(','),
  },
  {
    name: 'eve-assets',
    description: 'Assets: list, locations, names',
    endpoints: [
      'GET:/characters/{character_id}/assets/*',
      'POST:/characters/{character_id}/assets/locations/*',
      'POST:/characters/{character_id}/assets/names/*',
    ].join(','),
  },
  {
    name: 'eve-market',
    description: 'Market: character orders, structure market (public market data is in eve-public)',
    endpoints: [
      // Character orders (requires auth)
      'GET:/characters/{character_id}/orders/*',
      'GET:/characters/{character_id}/orders/history/*',
      // Structure market (requires auth)
      'GET:/markets/structures/{structure_id}/*',
    ].join(','),
  },
  {
    name: 'eve-industry',
    description: 'Industry: jobs, blueprints, mining, PI, public facilities',
    endpoints: [
      // Character industry
      'GET:/characters/{character_id}/industry/jobs/*',
      'GET:/characters/{character_id}/blueprints/*',
      'GET:/characters/{character_id}/mining/*',
      // Planetary interaction
      'GET:/characters/{character_id}/planets/*',
      'GET:/characters/{character_id}/planets/{planet_id}/*',
      // Public industry data
      'GET:/industry/facilities/*',
      'GET:/industry/systems/*',
    ].join(','),
  },
  {
    name: 'eve-contracts',
    description: 'Contracts: character contracts, bids, items, public contracts',
    endpoints: [
      // Character contracts
      'GET:/characters/{character_id}/contracts/*',
      'GET:/characters/{character_id}/contracts/{contract_id}/bids/*',
      'GET:/characters/{character_id}/contracts/{contract_id}/items/*',
      // Public contracts
      'GET:/contracts/public/{region_id}/*',
      'GET:/contracts/public/bids/{contract_id}/*',
      'GET:/contracts/public/items/{contract_id}/*',
    ].join(','),
  },
  {
    name: 'eve-mail',
    description: 'Mail: inbox, labels, lists',
    endpoints: [
      'GET:/characters/{character_id}/mail/*',
      'POST:/characters/{character_id}/mail/*',
      'GET:/characters/{character_id}/mail/{mail_id}/*',
      'PUT:/characters/{character_id}/mail/{mail_id}/*',
      'DELETE:/characters/{character_id}/mail/{mail_id}/*',
      'GET:/characters/{character_id}/mail/labels/*',
      'POST:/characters/{character_id}/mail/labels/*',
      'DELETE:/characters/{character_id}/mail/labels/{label_id}/*',
      'GET:/characters/{character_id}/mail/lists/*',
    ].join(','),
  },
  {
    name: 'eve-corp',
    description: 'Corporation: full corp data read-only',
    endpoints: [
      'GET:/corporations/{corporation_id}/*',
      'GET:/corporations/{corporation_id}/members/*',
      'GET:/corporations/{corporation_id}/members/limit/*',
      'GET:/corporations/{corporation_id}/members/titles/*',
      'GET:/corporations/{corporation_id}/membertracking/*',
      'GET:/corporations/{corporation_id}/roles/*',
      'GET:/corporations/{corporation_id}/roles/history/*',
      'GET:/corporations/{corporation_id}/structures/*',
      'GET:/corporations/{corporation_id}/starbases/*',
      'GET:/corporations/{corporation_id}/starbases/{starbase_id}/*',
      'GET:/corporations/{corporation_id}/wallets/*',
      'GET:/corporations/{corporation_id}/wallets/{division}/journal/*',
      'GET:/corporations/{corporation_id}/wallets/{division}/transactions/*',
      'GET:/corporations/{corporation_id}/assets/*',
      'POST:/corporations/{corporation_id}/assets/locations/*',
      'POST:/corporations/{corporation_id}/assets/names/*',
      'GET:/corporations/{corporation_id}/contacts/*',
      'GET:/corporations/{corporation_id}/contacts/labels/*',
      'GET:/corporations/{corporation_id}/contracts/*',
      'GET:/corporations/{corporation_id}/contracts/{contract_id}/bids/*',
      'GET:/corporations/{corporation_id}/contracts/{contract_id}/items/*',
      'GET:/corporations/{corporation_id}/industry/jobs/*',
      'GET:/corporations/{corporation_id}/orders/*',
      'GET:/corporations/{corporation_id}/orders/history/*',
      'GET:/corporations/{corporation_id}/blueprints/*',
      'GET:/corporations/{corporation_id}/containers/logs/*',
      'GET:/corporations/{corporation_id}/customs_offices/*',
      'GET:/corporations/{corporation_id}/divisions/*',
      'GET:/corporations/{corporation_id}/facilities/*',
      'GET:/corporations/{corporation_id}/medals/*',
      'GET:/corporations/{corporation_id}/medals/issued/*',
      'GET:/corporations/{corporation_id}/standings/*',
      'GET:/corporations/{corporation_id}/shareholders/*',
      'GET:/corporations/{corporation_id}/titles/*',
      'GET:/corporations/{corporation_id}/killmails/recent/*',
      'GET:/corporations/{corporation_id}/fw/stats/*',
      'GET:/corporations/{corporation_id}/alliancehistory/*',
      'GET:/corporations/{corporation_id}/icons/*',
      'GET:/corporations/{corporation_id}/mining/*',
      'GET:/corporations/npccorps/*',
    ].join(','),
  },
  {
    name: 'eve-ui',
    description: 'UI: autopilot waypoints, open in-game windows',
    endpoints: [
      'POST:/ui/autopilot/waypoint/*',
      'POST:/ui/openwindow/contract/*',
      'POST:/ui/openwindow/information/*',
      'POST:/ui/openwindow/marketdetails/*',
      'POST:/ui/openwindow/newmail/*',
    ].join(','),
  },
];

function setupProfile(profile: ProfileDef): void {
  const customHeaders = JSON.stringify({
    'User-Agent': USER_AGENT,
    'X-Compatibility-Date': COMPAT_DATE,
  });

  const args = [
    'openapi-to-cli',
    'onboard',
    '--api-base-url', ESI_BASE_URL,
    '--openapi-spec', ESI_SPEC_URL,
    '--profile', profile.name,
    '--include-endpoints', profile.endpoints,
    '--custom-headers', customHeaders,
  ];

  console.log(`[ocli-setup] ${profile.name} -- ${profile.description}`);
  try {
    execFileSync('npx', args, { stdio: 'inherit', timeout: 60_000 });
    console.log(`  OK`);
  } catch (err) {
    console.error(`  FAIL: ${(err as Error).message}`);
  }
}

function main() {
  console.log(`[ocli-setup] Registering ${PROFILES.length} EVE ESI profiles`);
  console.log(`[ocli-setup] Spec: ${ESI_SPEC_URL}\n`);

  for (const profile of PROFILES) {
    setupProfile(profile);
  }

  console.log(`\n[ocli-setup] Done. Verify: npx openapi-to-cli profiles list`);
}

main();
