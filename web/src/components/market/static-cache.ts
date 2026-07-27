/**
 * Кэш неизменяемых данных SDE в памяти вкладки. Дерево маркет-групп, состав
 * групп и результаты поиска по типам меняются раз в патч, поэтому повторные
 * запросы в рамках сессии вкладки не имеют смысла. Кэшируем сам Promise, чтобы
 * параллельные вызовы с одним ключом дедуплицировались в один сетевой запрос.
 * Ошибки не кэшируются: неудачный Promise вытесняется, повтор — это новый запрос.
 *
 * Два предохранителя против вечной несвежести и разрастания: потолок записей
 * с выселением самых старых (Map итерируется в порядке вставки) и полная
 * чистка при logout — иначе смена пользователя или патч-день оставляли
 * вкладку на чужих/протухших данных до перезагрузки.
 */
const MAX_ENTRIES = 300;

const cache = new Map<string, Promise<unknown>>();

export function cachedMarketStatic<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const pending = loader();
  cache.set(key, pending);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

/** Смена пользователя/выход: статика следующего сеанса запрашивается заново. */
export function clearMarketStaticCache(): void {
  cache.clear();
}
