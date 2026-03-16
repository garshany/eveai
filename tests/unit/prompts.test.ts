import { describe, expect, it } from 'vitest';
import { buildDeveloperPrompt } from '../../src/agent/prompts.js';

describe('buildDeveloperPrompt', () => {
  it('keeps the main prompt compact and focused', () => {
    const prompt = buildDeveloperPrompt();

    expect(prompt).toContain('Всегда отвечай по-русски');
    expect(prompt).toContain('Не раскрывай внутреннюю кухню');
    expect(prompt).toContain('Иди самым коротким корректным путём');
    expect(prompt).toContain('Для простого запроса не запускай широкое исследование');
    expect(prompt).toContain('По умолчанию отвечай компактно');
    expect(prompt).toContain('не отвечай teaser-версией');
    expect(prompt).toContain('Не выдавай предположение');
    expect(prompt).toContain('Не придумывай точные даты');
    expect(prompt).toContain('Для живых игровых данных используй ESI');
    expect(prompt).toContain('Для статических данных и идентификаторов используй SDE');
    expect(prompt).toContain('Для внешних справок и механик вне ESI/SDE используй web search');
    expect(prompt).toContain('tool_search');
    expect(prompt).toContain('get_eve_capabilities');
    expect(prompt).toContain('update_plan');
    expect(prompt).toContain('Предпочитай самый узкий endpoint-tool');
    expect(prompt).toContain('Не спрашивай у пользователя character_id');
    expect(prompt).toContain('Формат финального ответа');
    expect(prompt).toContain('1-2 коротких фразах без обязательного отчёта');
    expect(prompt).toContain('Не записывай plan повторно без необходимости');
    expect(prompt).toContain('Не вызывай get_eve_capabilities повторно');
    expect(prompt).toContain('Не повторяй один и тот же tool call');
    expect(prompt).toContain('пиши как полезный пилот-ассистент');
    expect(prompt).toContain('Не говори "кто кого убил"');
    expect(prompt).not.toContain('fit-блок');
    expect(prompt.length).toBeLessThan(7000);
  });

  it('appends profile and summary when provided', () => {
    const prompt = buildDeveloperPrompt('summary text', 'profile text');

    expect(prompt).toContain('USER.md (профиль пользователя):\nprofile text');
    expect(prompt).toContain('Долгая память (сводка):\nsummary text');
  });

  it('describes hosted tool_search workflow instead of shortcut-specific routing', () => {
    const prompt = buildDeveloperPrompt();

    expect(prompt).toContain('используй tool_search');
    expect(prompt).toContain('загрузи самый узкий подходящий инструмент или namespace');
    expect(prompt).toContain('После failed tool call не угадывай результат');
    expect(prompt).toContain('Не используй web_search для резолва EVE system/type/region IDs');
    expect(prompt).not.toContain('не собирай fit заново');
    expect(prompt).not.toContain('System Prompt');
  });
});
