/**
 * Марка проекта — огранённый шестиугольный «кристалл» с циановым ядром: тот же
 * знак носит аватар агента в треде, поэтому «EVE AI» и голос, который отвечает,
 * читаются как одно и то же. Рисуется CSS-градиентом и clip-path (класс
 * `sun-disc` сохранён как легаси-имя) — отдельного ассета и чужих логотипов нет.
 */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`} aria-label="EVE AI">
      <span className="brand__mark sun-disc" aria-hidden="true" />
      <span className="brand__wordmark">EVE <strong>AI</strong></span>
    </div>
  );
}
