import { describe, expect, it } from 'vitest';
import { buildDeveloperPrompt } from '../../src/agent/prompts.js';
import { buildEveConsentPage } from '../../src/web/eve-consent.js';

describe('EVE informed-consent disclosure contract', () => {
  it('discloses the persistent model context that normal agent turns actually include', () => {
    const prompt = buildDeveloperPrompt({
      authenticated: true,
      characterId: 123,
      characterName: 'Pilot',
      grantedScopes: ['esi-location.read_location.v1'],
    }, 'conversation-summary-sentinel', 'profile-sentinel');
    expect(prompt).toContain('<user_profile_data>');
    expect(prompt).toContain('profile-sentinel');
    expect(prompt).toContain('<conversation_summary_data>');
    expect(prompt).toContain('conversation-summary-sentinel');

    const page = buildEveConsentPage('state');
    expect(page).toContain('Each normal request');
    expect(page).toContain('conversation context');
    expect(page).toContain('stored EVE profile');
    expect(page).toContain('wallet balance');
    expect(page).toContain('Tool results needed for the question are also sent to the model');
    expect(page).toContain('EVE tokens are never sent');
  });

  it('names every sensitive data class represented by broad scope groups in both languages', () => {
    const page = buildEveConsentPage('state');
    for (const term of [
      'loyalty points',
      'titles',
      'medals',
      'jump fatigue',
      'notifications',
      'research agents',
      'corporation roles',
      'fleet data',
      'container logs',
      'customs offices',
      'FW statistics',
      'member tracking',
    ]) {
      expect(page).toContain(term);
    }
    for (const term of [
      'LP',
      'титулы',
      'медали',
      'усталость прыжков',
      'уведомления',
      'исследования агентов',
      'роли корпорации',
      'данные флота',
      'журналы контейнеров',
      'таможни',
      'FW-статистика',
      'отслеживание участников',
    ]) {
      expect(page).toContain(term);
    }
  });

  it('marks English headings and controls for assistive technology', () => {
    const page = buildEveConsentPage('state');
    expect(page).toContain('<small lang="en">Navigation and current ship</small>');
    expect(page).toContain('<label lang="en"><input type="radio" name="language" value="en"> English</label>');
    expect(page).toContain('<span lang="en">Continue to EVE SSO');
  });
});
