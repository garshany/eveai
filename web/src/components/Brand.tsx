/**
 * Марка проекта — солнечный диск: тот же градиент носит аватар агента в треде,
 * поэтому знак «EVE AI» и голос, который отвечает, читаются как одно и то же.
 * Диск рисуется CSS-градиентом, а не иконкой, — отдельного ассета не нужно.
 */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`} aria-label="EVE AI">
      <span className="brand__mark sun-disc" aria-hidden="true" />
      <span className="brand__wordmark">EVE <strong>AI</strong></span>
    </div>
  );
}
