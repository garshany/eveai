import type { UpdateStatus } from './check.js';

export function formatUpdateStatus(status: UpdateStatus): string {
  switch (status.kind) {
    case 'current':
      return `EVE AI Agent v${status.current}\nУстановлен актуальный стабильный релиз.`;
    case 'available':
      return [
        `EVE AI Agent v${status.current}`,
        `Доступен стабильный релиз v${status.latest}: ${status.releaseUrl}`,
        'Обновление устанавливает оператор локально на хосте; команды из чата ничего не меняют.',
      ].join('\n');
    case 'ahead':
      return [
        `EVE AI Agent v${status.current}`,
        `Установленная версия новее последнего стабильного релиза v${status.latest}.`,
      ].join('\n');
    case 'unavailable': {
      const detail = status.reason === 'rate_limited'
        ? 'GitHub временно ограничил частоту запросов.'
        : status.reason === 'invalid_response'
          ? 'GitHub вернул неожиданные данные.'
          : 'GitHub сейчас недоступен.';
      return `EVE AI Agent v${status.current}\n${detail} Проверка обновлений не влияет на работу агента.`;
    }
  }
}
