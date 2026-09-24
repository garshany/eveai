/**
 * Цветовой класс статуса безопасности системы: 1.0 синий → 0.5 жёлто-зелёный →
 * 0.4–0.1 оранжево-красный → 0.0 и ниже красный. Сами цвета — токены
 * `--sec-10 … --sec-00` в styles.css; здесь только выбор ступени.
 *
 * Ступень считается так же, как в игре: истинное значение округляется до
 * десятых, но лоусек в (0, 0.05) не проваливается в «0.0» — он остаётся 0.1.
 */
export function securityTier(security: number): string {
  if (!Number.isFinite(security) || security <= 0) return '00';
  // Через toFixed(1), а не Math.round(x * 10): цвет обязан совпадать с цифрой
  // рядом, а 0.95 в двоичной записи — это 0.9499…, и toFixed покажет «0.9».
  const rounded = security < 0.05 ? 1 : Math.round(Number(security.toFixed(1)) * 10);
  return String(Math.min(10, Math.max(0, rounded))).padStart(2, '0');
}

/** `sec sec--05` / `sec-badge sec--05` — готовая строка для className. */
export function securityClassName(security: number, base: 'sec' | 'sec-badge' = 'sec'): string {
  return `${base} sec--${securityTier(security)}`;
}
