/**
 * Раскладки «Периметра».
 *
 * Две системы координат для одних и тех же узлов:
 *
 * - **Эго-кольца (основная).** Пилот в центре, номер кольца = число прыжков.
 *   Расстояние на экране становится прыжковым, а не световым — именно этого
 *   нет ни у Dotlan, ни у EVEEye, и именно это отвечает на вопрос «насколько
 *   близко опасность». Угол берётся из настоящих 2D-координат SDE, поэтому
 *   топология по-прежнему «ощущается» географически.
 * - **Географическая (вторая).** Настоящие координаты, привычный вид.
 *
 * Обе возвращают позиции для одного и того же набора id, поэтому переход между
 * ними — интерполяция, а не пересборка сцены.
 */

import type { MapBubble } from '../../types';

export type LayoutMode = 'ego' | 'geo';

export type NodePosition = { x: number; y: number };
export type Layout = Map<number, NodePosition>;

/** Расстояние между кольцами в мировых единицах. */
const RING_STEP = 120;
/** Минимальный зазор между соседями на кольце, чтобы подписи не слипались. */
const MIN_ARC_GAP = 26;

export function buildLayout(bubble: MapBubble, mode: LayoutMode): Layout {
  return mode === 'ego' ? buildEgoLayout(bubble) : buildGeoLayout(bubble);
}

/**
 * Кольца по числу прыжков. Внутри кольца системы сортируются по настоящему
 * географическому углу относительно центра и затем равномерно разводятся по
 * дуге: сохранить порядок важнее, чем сохранить точный угол — иначе на кольце
 * из шестидесяти систем половина окажется в одной точке.
 */
function buildEgoLayout(bubble: MapBubble): Layout {
  const layout: Layout = new Map();
  const origin = bubble.systems.find((system) => system.systemId === bubble.originId);
  const originX = origin?.mapX ?? 0;
  const originY = origin?.mapY ?? 0;

  const byRing = new Map<number, typeof bubble.systems>();
  for (const system of bubble.systems) {
    const ring = byRing.get(system.jumps);
    if (ring) ring.push(system);
    else byRing.set(system.jumps, [system]);
  }

  for (const [jumps, systems] of byRing) {
    if (jumps === 0) {
      for (const system of systems) layout.set(system.systemId, { x: 0, y: 0 });
      continue;
    }

    const withAngle = systems.map((system) => ({
      system,
      // atan2 на реальных координатах: север карты остаётся севером кольца.
      angle: Math.atan2(system.mapY - originY, system.mapX - originX),
    }));
    withAngle.sort((a, b) => a.angle - b.angle || a.system.systemId - b.system.systemId);

    // Радиус кольца растёт от номера прыжка, но раздувается, если систем на
    // кольце столько, что они физически не помещаются с нужным зазором.
    const baseRadius = jumps * RING_STEP;
    const needed = (withAngle.length * MIN_ARC_GAP) / (2 * Math.PI);
    const radius = Math.max(baseRadius, needed);

    for (let index = 0; index < withAngle.length; index += 1) {
      const entry = withAngle[index]!;
      // Равномерная развёртка в порядке географического угла: первый узел
      // остаётся примерно там, где он был по-настоящему.
      const spread = (index / withAngle.length) * 2 * Math.PI;
      const anchor = withAngle[0]!.angle;
      const angle = anchor + spread;
      layout.set(entry.system.systemId, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }
  }

  return layout;
}

/**
 * Настоящие координаты, отнормированные так, чтобы пузырь любого размера занял
 * сопоставимую область экрана. Центр — позиция пилота, чтобы переключение
 * раскладки не швыряло камеру.
 */
function buildGeoLayout(bubble: MapBubble): Layout {
  const layout: Layout = new Map();
  if (bubble.systems.length === 0) return layout;

  const origin = bubble.systems.find((system) => system.systemId === bubble.originId);
  const originX = origin?.mapX ?? 0;
  const originY = origin?.mapY ?? 0;

  let maxDistance = 0;
  for (const system of bubble.systems) {
    const dx = system.mapX - originX;
    const dy = system.mapY - originY;
    maxDistance = Math.max(maxDistance, Math.hypot(dx, dy));
  }
  // Пузырь в одну систему или вырожденные координаты: масштаб 1, без деления
  // на ноль.
  const target = Math.max(1, bubble.radius) * RING_STEP;
  const scale = maxDistance > 0 ? target / maxDistance : 1;

  for (const system of bubble.systems) {
    layout.set(system.systemId, {
      x: (system.mapX - originX) * scale,
      // Экранная ось Y растёт вниз, а карта EVE считает вверх.
      y: -(system.mapY - originY) * scale,
    });
  }
  return layout;
}

/**
 * Покадровая интерполяция между раскладками. Узел, которого нет в одной из
 * них (пузырь сдвинулся во время морфа), берёт позицию из той, где он есть, —
 * появление системы не должно выглядеть как прилёт из центра координат.
 */
export function interpolateLayouts(from: Layout, to: Layout, t: number): Layout {
  const eased = easeInOutCubic(clamp01(t));
  const result: Layout = new Map();
  const ids = new Set([...from.keys(), ...to.keys()]);
  for (const id of ids) {
    const a = from.get(id);
    const b = to.get(id);
    if (a && b) {
      result.set(id, { x: a.x + (b.x - a.x) * eased, y: a.y + (b.y - a.y) * eased });
    } else {
      result.set(id, (b ?? a)!);
    }
  }
  return result;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
