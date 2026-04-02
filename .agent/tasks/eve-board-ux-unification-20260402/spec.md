# Task Spec: eve-board UX unification

## Original task

Подумать глубже о смысле системы и собрать coherent UX для travel assistant: pre-flight + live ESP должны работать как единый помощник при передвижении, а не как набор разрозненных текстов.

## Problem statement

Сейчас маршрутный UX собран из нескольких независимых слоёв:

1. `plan_route` выдаёт большой route summary с маршрутами, таблицей и списком опасных систем.
2. `generateBriefing()` добавляет отдельный pre-flight briefing со своей логикой формулировок и своим verdict.
3. `route-monitor` затем шлёт live ESP digests с уже другим тоном и другой структурой.

Из-за этого пользователь получает:

- два pre-flight сообщения в одном ответе, которые частично дублируют друг друга;
- слишком много второстепенных данных до того, как дана основная рекомендация;
- смешение текущего риска, риска впереди по маршруту и фоновой активности;
- inconsistency между initial route answer и subsequent live ESP;
- сообщения, которые выглядят как аналитический dump, а не как cockpit assistant для пилота.

## Product intent

Система должна быть легальным travel ESP по API и помогать пилоту принять решение за 2-3 секунды. На каждом этапе она должна отвечать на три вопроса:

1. Можно ли выходить / продолжать маршрут прямо сейчас?
2. Где ближайшая релевантная точка риска?
3. Что делать: идти, идти осторожно, ждать, стоп/док, обходить?

## Constraints

- Сохранять single-process Node.js архитектуру и существующие runtime boundaries.
- Не раскрывать модели токены, refresh flow, retry logic или транспортные детали приватного ESI.
- Не ломать автозапуск route monitor через `plan_route`.
- Делать минимальный безопасный дифф, но с явным UX-contract в коде.
- Если меняется поведение, обновить релевантную документацию в `docs/`.
- Следовать repo-task-proof-loop и сохранить артефакты в этой task-папке.

## Non-goals

- Не переписывать весь threat engine.
- Не менять transport/API boundaries Telegram/ESI.
- Не строить новый web UX; Telegram остаётся основным интерфейсом.
- Не убирать completely детальные kill/danger данные — они должны остаться как secondary layer.

## Acceptance criteria

- AC1: pre-flight ответ становится одним связным travel-brief и больше не склеивает два независимых больших блока (`route summary` + отдельный `briefing`) с повторяющейся или противоречивой информацией.
- AC2: основное сообщение строится вокруг action-state для пилота: `ВЫХОДИ`, `ОСТОРОЖНО`, `ЖДАТЬ`, `СТОП`, `ОБХОД` (или эквивалентных user-facing формулировок), текущей позиции и ближайших рисков впереди.
- AC3: альтернативные маршруты, route comparison и детальные kill/danger данные остаются доступны, но уходят в компактный или вторичный слой и не забивают основной verdict.
- AC4: live ESP сохраняет state-change поведение и не противоречит pre-flight UX contract по структуре и смыслу; pilot-facing action semantics остаются согласованными между initial answer и monitor digests.
- AC5: обновлены tests и docs, фиксирующие новый UX contract и отсутствие regressions в travel-assistant flow.

## Design direction

### Pre-flight

Основной ответ должен иметь стабильный порядок:

1. Маршрут / выбранный вариант
2. Action-state
3. Сейчас (стартовая система / undock risk)
4. Впереди (ближайшие 1-3 релевантные точки)
5. Действие
6. Компактный secondary layer: альтернативы, трафик, детали киллов

### Live ESP

Live digests должны быть state-driven:

- отправлять обновление при meaningful change;
- не пересказывать весь маршрут;
- фокусироваться на current system, nearest threat ahead, pursuit if any, and next action.

### Detail layering

Primary layer:
- решение пилота
- текущая позиция
- ближайшие угрозы

Secondary layer:
- alternative route comparison
- detailed kills / names / ISK
- long-form reasoning

## Verification plan

1. Обновить/добавить unit tests на pre-flight formatter/UX contract.
2. Обновить/добавить unit tests на live ESP action/state consistency.
3. Прогнать `npm run typecheck`, targeted `vitest`, `npm run lint`, и полный `npm run check`.
4. Зафиксировать evidence в `evidence.md`, `evidence.json`, raw artifacts при необходимости.

## Assumptions

- Для Telegram важнее короткий cockpit-style answer, чем полный аналитический dump.
- Пользователь принимает route decision по выбранному маршруту, а не по merged set всех альтернативных систем сразу.
- LOW-signal states лучше выражать детерминированным UX, а LLM оставлять как secondary reasoning layer for ambiguous/action-heavy cases.
