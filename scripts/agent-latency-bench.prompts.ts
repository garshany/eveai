/**
 * Fixed prompt set for agent-latency-bench.ts. Edit freely; keep
 * `heavy-region-price-compare` — it reproduces the 12-iteration production
 * turn that motivated the bench.
 */
export type LatencyBenchPrompt = {
  id: string;
  text: string;
};

export const LATENCY_BENCH_PROMPTS: LatencyBenchPrompt[] = [
  {
    id: 'greeting-capabilities',
    text: 'Привет! Что ты умеешь?',
  },
  {
    id: 'static-system-count',
    text: 'Сколько систем в регионе The Forge?',
  },
  {
    id: 'market-single-price',
    text: 'Какая сейчас лучшая цена продажи на Tritanium в The Forge?',
  },
  {
    id: 'route-jita-amarr',
    text: 'Построй маршрут из Jita в Amarr: сколько прыжков и есть ли опасные системы по пути?',
  },
  {
    id: 'heavy-region-price-compare',
    text: 'Сравни цены в регионах: найди лучшие цены покупки и продажи на Tritanium, Pyerite, Mexallon и Isogen в регионах The Forge, Domain, Sinq Laison и Heimatar. Скажи, где выгоднее покупать каждый товар, а где продавать.',
  },
];
