# Task Spec: native-tool-state-recovery

## Metadata
- Task ID: native-tool-state-recovery
- Created: 2026-03-26T00:00:00+03:00
- Repo root: /home/antipedik/eveai

## Original task statement
Проверить продовый сбой на вопросе "Сколько лун в моем регионе?", найти причину по логам, починить, добавить регрессионную защиту и выкатить фикс.

## Acceptance criteria
- AC1: Если native responses loop падает на рассинхроне proxy-side tool state (`No tool call found for function call output with call_id ...`), агент не должен завершать запрос жёсткой ошибкой с первого раза.
- AC2: При таком рассинхроне рантайм должен безопасно сбрасывать warm continuation и переходить на SQLite-backed cold recovery context без утраты уже собранных tool результатов текущего треда.
- AC3: Должен появиться unit-level regression test на recovery context / cold fallback поведение.
- AC4: Документация по reliability должна отражать, что потеря proxy-side tool state приводит к cold recovery, а не к немедленному провалу ответа.
- AC5: Изменения должны проходить релевантные unit tests и сборку.

## Constraints
- Не менять single-process архитектуру.
- Не скрывать и не отбрасывать tool results, уже записанные в SQLite.
- Делать минимальный безопасный diff вокруг native responses loop и context recovery.

## Non-goals
- Полный редизайн planner/tool policy.
- Переделка codex proxy.
- Оптимизация moon-count запроса как отдельной feature, если recovery fix уже закрывает падение.
