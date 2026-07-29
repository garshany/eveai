import { describe, expect, it } from 'vitest';
import { buildDeveloperPrompt } from '../../src/agent/prompts.js';
import { buildNativeAgentTools } from '../../src/agent/tools.js';

const CAPABILITIES = {
  authenticated: true,
  characterId: 90_000_001,
  characterName: 'Test Pilot',
  grantedScopes: ['esi-location.read_location.v1'],
};

function toolNames(tools: Awaited<ReturnType<typeof buildNativeAgentTools>>): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    if (tool.type === 'function') names.push(tool.name);
    else if (tool.type === 'namespace') names.push(tool.name);
  }
  return names;
}

/**
 * «Периметр» — отдельный ассистент, а не основной агент с прикрученной картой.
 * Его отличают промпт и каталог инструментов; и то и другое проверяется здесь,
 * потому что разъехавшись они дают агента, который обещает то, чего не умеет.
 */
describe('Perimeter is its own assistant', () => {
  it('has a flight-assistant prompt, not the workspace one', () => {
    const perimeter = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    const workspace = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'full');

    expect(perimeter).toContain('Периметр');
    expect(perimeter).not.toBe(workspace);
    expect(perimeter).not.toContain('EVE Endpoint Agent');
  });

  it('is told the two things it must never claim', () => {
    const prompt = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    // Эндпоинта присутствия в системе не существует — обещать его нельзя.
    expect(prompt).toContain('cannot see who is in a system');
    // Часовой срез ESI — не «сейчас».
    expect(prompt.toLowerCase()).toContain('hourly esi baseline');
  });

  it('is told to check the planned route before denying it exists', () => {
    // Ровно тот случай, который сломал доверие в первом полёте: маршрут
    // построен на карте, а агент отвечает «активного маршрута нет».
    const prompt = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    expect(prompt).toContain('map_bubble_intel.active_route');
  });

  /**
   * Промт описывал один маршрутный инструмент из двух и ни словом не упоминал,
   * что маршрут рисуется на карте пилота. Ничто не мешало модели собрать список
   * прыжков из sde_stargates и выдать прозой — маршрут, который на карту не
   * попадёт никогда.
   */
  it('knows plan_route exists and that it takes system names', () => {
    const prompt = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    expect(prompt).toContain('plan_route');
    expect(prompt).toContain('It takes system names');
  });

  it('knows route_risk takes numeric ids, never names', () => {
    const prompt = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    expect(prompt).toContain('never names');
    expect(prompt).toContain('draw_on_map');
  });

  it('is told that planning a route draws the line the pilot steers by', () => {
    const prompt = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    expect(prompt).toContain('draw the route on the pilot');
  });

  it('is forbidden from hand-rolling a hop list out of the SDE', () => {
    const prompt = buildDeveloperPrompt(CAPABILITIES, null, null, null, 'perimeter');
    expect(prompt).toContain('sde_sql');
    expect(prompt).toContain('is prose');
  });

  it('carries the map tools', async () => {
    const names = toolNames(await buildNativeAgentTools('perimeter'));
    expect(names).toEqual(expect.arrayContaining([
      'map_bubble_intel',
      'route_risk',
      'threat_explain',
      'compare_ships',
    ]));
  });

  it('keeps route planning and the pilot\'s own data', async () => {
    const names = toolNames(await buildNativeAgentTools('perimeter'));
    expect(names).toEqual(expect.arrayContaining(['plan_route', 'character_sql', 'sde_sql']));
  });

  it('drops the trading and industry catalog', async () => {
    const names = toolNames(await buildNativeAgentTools('perimeter'));
    // Пилот в варпе не спрашивает про маржу: лишний каталог только уводит
    // модель в рыночные обходы вместо ответа «прыгать или нет».
    for (const absent of [
      'batch_market_prices',
      'market_wide_summary',
      'market_history_summary',
      'assets_summary',
      'character_orders_summary',
      'doctrine_summary',
    ]) {
      expect(names, `${absent} should not be offered to the flight assistant`).not.toContain(absent);
    }
  });

  it('still offers the full catalog to the workspace agent', async () => {
    const names = toolNames(await buildNativeAgentTools('full'));
    expect(names).toEqual(expect.arrayContaining(['market_wide_summary', 'map_bubble_intel']));
  });
});
