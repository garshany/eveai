import { describe, expect, it } from 'vitest';
import {
  ALL_REQUESTED_SCOPES,
  EVE_ACCESS_GROUPS,
  scopesForEveAccessGroups,
} from '../../src/eve/scopes.js';

describe('EVE least-privilege access groups', () => {
  it('partitions every supported scope exactly once', () => {
    const groupedScopes = Object.values(EVE_ACCESS_GROUPS).flat();
    expect(groupedScopes).toHaveLength(58);
    expect(new Set(groupedScopes).size).toBe(groupedScopes.length);
    expect(ALL_REQUESTED_SCOPES).toEqual(groupedScopes);
  });

  it('returns only scopes from the selected groups and supports identity-only login', () => {
    expect(scopesForEveAccessGroups([])).toEqual([]);
    const navigation = scopesForEveAccessGroups(['navigation']);
    expect(navigation).toContain('esi-location.read_location.v1');
    expect(navigation).not.toContain('esi-wallet.read_character_wallet.v1');
    expect(navigation).not.toContain('esi-ui.write_waypoint.v1');
  });

  it('keeps model-triggered writes in the explicit actions group', () => {
    expect(EVE_ACCESS_GROUPS.actions).toEqual(expect.arrayContaining([
      'esi-mail.send_mail.v1',
      'esi-fleets.write_fleet.v1',
      'esi-ui.write_waypoint.v1',
      'esi-fittings.write_fittings.v1',
    ]));
  });
});
