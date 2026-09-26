/**
 * Рендерер «Периметра» — Canvas 2D, свой цикл, без граф-библиотеки.
 *
 * Почему не Sigma/Cytoscape/d3-force: раскладка здесь детерминированная
 * (кольцо = число прыжков), силовая симуляция сломала бы ровно то свойство,
 * ради которого карта делается, а кастомная графика — кольца, вспышки килов,
 * лента маршрута, камера-следование — в WebGL-библиотеках упирается в шейдеры.
 * Из d3 берутся только зум-трансформация и quadtree для попаданий курсором.
 *
 * Бюджет кадра: потолок пузыря 1200 узлов и ~2000 рёбер. Рёбра рисуются одним
 * батчем на цвет, подписи — только выше порога зума, вспышки живут секунду.
 */

import { quadtree, type Quadtree } from 'd3-quadtree';
import type { ZoomTransform } from 'd3-zoom';
import type { DangerBand, MapBubble, MapBubbleSystem } from '../../types';
import type { Layout } from './layout';
import { routeBreaks, splitRouteRuns } from './route-view';

export type RenderNode = {
  systemId: number;
  x: number;
  y: number;
  system: MapBubbleSystem;
};

export type KillFlash = { systemId: number; startedAt: number; value: number };

export type RenderInput = {
  bubble: MapBubble;
  layout: Layout;
  transform: ZoomTransform;
  /** Идентификатор системы пилота — рисуется маркером, а не точкой. */
  pilotSystemId: number | null;
  /** False when the position is a last-known one rather than live movement. */
  pilotOnline: boolean;
  /** «Вы · Gila» под маркером пилота; null — только маркер. */
  pilotLabel?: string | null;
  selectedSystemId: number | null;
  hoveredSystemId: number | null;
  routeSystemIds: number[];
  flashes: KillFlash[];
  showLabels: boolean;
  now: number;
  reducedMotion: boolean;
};

export const FLASH_MS = 1600;

/**
 * How far along a kill flash is, in [0, 1], or null once it has burnt out.
 * Shared by the bubble renderer and the whole-map canvas so both flash alike.
 */
export function flashProgress(flash: KillFlash, now: number, reducedMotion: boolean): number | null {
  const age = now - flash.startedAt;
  if (age < 0 || age > FLASH_MS) return null;
  return reducedMotion ? 0.5 : age / FLASH_MS;
}
/** Ниже этого зума подписываются только важные системы, выше — все, что влезают. */
const LABEL_ZOOM_THRESHOLD = 0.55;
const RING_COLOR = 'rgba(120, 170, 200, 0.10)';
/** Кил старше этого окна больше не тлеет на карте. */
const EMBER_WINDOW_MS = 60 * 60_000;
/** Столько ESI-прыжков в час дают максимальную плотность трафика на гейте. */
const TRAFFIC_FULL_JUMPS = 120;

/**
 * Статус безопасности — теми же цветами, что и в остальном интерфейсе
 * (--sec-* в styles.css): пилот читает их не глядя, как в клиенте игры.
 */
const SECURITY_COLORS = [
  '#f24b62', '#f0524a', '#ea4a34', '#ec6a2c', '#f0902a',
  '#e3ec6c', '#7ee25c', '#5fdcaa', '#4fd2f2', '#3fb0f2', '#4a8fff',
];

export function securityColor(security: number): string {
  if (!Number.isFinite(security) || security <= 0) return SECURITY_COLORS[0]!;
  const tier = security < 0.05 ? 1 : Math.round(Number(security.toFixed(1)) * 10);
  return SECURITY_COLORS[Math.max(0, Math.min(10, tier))]!;
}

const BAND_COLORS: Record<DangerBand, string> = {
  calm: '#3f9d6b',
  watch: '#c6b447',
  elevated: '#d98f3d',
  hostile: '#d1603d',
  lethal: '#e2453c',
};

/** Цвет узла: полоса опасности, а не security — карта отвечает «опасно ли мне». */
export function bandColor(band: DangerBand): string {
  return BAND_COLORS[band] ?? BAND_COLORS.calm;
}

export function buildRenderNodes(bubble: MapBubble, layout: Layout): RenderNode[] {
  const nodes: RenderNode[] = [];
  for (const system of bubble.systems) {
    const position = layout.get(system.systemId);
    if (!position) continue;
    nodes.push({ systemId: system.systemId, x: position.x, y: position.y, system });
  }
  return nodes;
}

/** Индекс попаданий в мировых координатах; строится один раз на раскладку. */
export function buildHitIndex(nodes: RenderNode[]): Quadtree<RenderNode> {
  return quadtree<RenderNode>()
    .x((node) => node.x)
    .y((node) => node.y)
    .addAll(nodes);
}

export function pickNode(
  index: Quadtree<RenderNode>,
  worldX: number,
  worldY: number,
  radius: number,
): RenderNode | null {
  return index.find(worldX, worldY, radius) ?? null;
}

export function render(
  ctx: CanvasRenderingContext2D,
  nodes: RenderNode[],
  input: RenderInput,
  width: number,
  height: number,
): void {
  const { transform } = input;
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const byId = new Map(nodes.map((node) => [node.systemId, node]));

  drawRings(ctx, input, transform.k);
  drawEdges(ctx, input, byId);
  drawTraffic(ctx, input, byId);
  drawWormholes(ctx, input, byId);
  drawRoute(ctx, input, byId);
  drawNodes(ctx, nodes, input, transform.k);
  drawEmbers(ctx, input, byId);
  drawFlashes(ctx, input, byId);
  drawPilot(ctx, input, byId);
  drawLabels(ctx, nodes, input, width, height);

  ctx.restore();
}

/**
 * Кольца прыжковой дистанции. Это не декор: без них номер кольца не читается,
 * а он и есть главная величина на этой карте.
 */
function drawRings(ctx: CanvasRenderingContext2D, input: RenderInput, scale: number): void {
  if (input.bubble.radius <= 0) return;
  ctx.save();
  ctx.strokeStyle = RING_COLOR;
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([2 / scale, 6 / scale]);
  for (let ring = 1; ring <= input.bubble.radius; ring += 1) {
    ctx.beginPath();
    ctx.arc(0, 0, ring * 120, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Все гейты одним путём: 2000 отдельных stroke() стоили бы кадра. */
function drawEdges(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(128, 176, 206, 0.16)';
  ctx.lineWidth = 1 / input.transform.k;
  ctx.beginPath();
  for (const [from, to] of input.bubble.edges) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Трафик — частицы, бегущие по гейтам. Плотность и скорость берутся из
 * почасовых ESI-прыжков обеих систем (baselineJumps), а не выдумываются:
 * пустой гейт остаётся пустым. Направление ESI не сообщает, поэтому частицы
 * идут в обе стороны. При reduced-motion слоя нет — он и есть движение.
 */
function drawTraffic(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.reducedMotion) return;
  const scale = input.transform.k;
  const size = 1.6 / scale;
  ctx.save();
  ctx.fillStyle = 'rgba(170, 225, 245, 0.55)';
  ctx.beginPath();
  for (const [from, to] of input.bubble.edges) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;
    const jumps = (a.system.baselineJumps + b.system.baselineJumps) / 2;
    if (jumps <= 0) continue;
    const density = Math.min(1, jumps / TRAFFIC_FULL_JUMPS);
    const particles = density > 0.66 ? 3 : density > 0.25 ? 2 : 1;
    const seed = hash01(from * 31 + to);
    // Медленно на тихом гейте, заметно быстрее на загруженном.
    const period = 9000 - density * 5000;
    for (let index = 0; index < particles; index += 1) {
      const forward = index % 2 === 0;
      let t = ((input.now / period) + seed + index / particles) % 1;
      if (!forward) t = 1 - t;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.moveTo(x + size, y);
      ctx.arc(x, y, size, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
}

function drawWormholes(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.bubble.wormholes.length === 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.75)';
  ctx.lineWidth = 1.6 / input.transform.k;
  ctx.setLineDash([6 / input.transform.k, 4 / input.transform.k]);
  ctx.beginPath();
  for (const link of input.bubble.wormholes) {
    const a = byId.get(link.fromSystemId);
    const b = byId.get(link.toSystemId);
    if (!a || !b) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * The route, drawn only where this bubble can actually place it.
 *
 * Each contiguous stretch is its own path. Skipping absent systems while
 * continuing one path — which is what this used to do — draws a straight line
 * between two systems that share no gate, inventing a jump the pilot cannot
 * make. Where the route runs off the edge of the bubble it gets a short dashed
 * tail instead; the HUD chip carries the number of jumps that are missing.
 *
 * Drawn as a soft glow under a thin core, with a light pulse running from the
 * start toward the destination so the direction reads without arrows.
 */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.routeSystemIds.length < 2) return;
  const present = (systemId: number): boolean => byId.has(systemId);
  const runs = splitRouteRuns(input.routeSystemIds, present);
  if (runs.length === 0) return;

  const scale = input.transform.k;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const tracePath = (run: number[]): void => {
    ctx.beginPath();
    for (let index = 0; index < run.length; index += 1) {
      const node = byId.get(run[index]!)!;
      if (index === 0) ctx.moveTo(node.x, node.y);
      else ctx.lineTo(node.x, node.y);
    }
  };

  for (const run of runs) {
    // A lone system between two absent ones is a dot, not a segment.
    if (run.length < 2) continue;
    tracePath(run);
    ctx.strokeStyle = 'rgba(69, 211, 230, 0.16)';
    ctx.lineWidth = 10 / scale;
    ctx.stroke();
    tracePath(run);
    ctx.strokeStyle = 'rgba(143, 233, 245, 0.95)';
    ctx.lineWidth = 2 / scale;
    ctx.stroke();

    if (!input.reducedMotion) {
      // Бегущий импульс: где на маршруте «сейчас» свет, по длине пути.
      const points = run.map((id) => byId.get(id)!);
      let total = 0;
      for (let index = 1; index < points.length; index += 1) {
        total += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
      }
      if (total > 0) {
        let remaining = ((input.now / 2600) % 1) * total;
        for (let index = 1; index < points.length; index += 1) {
          const from = points[index - 1]!;
          const to = points[index]!;
          const length = Math.hypot(to.x - from.x, to.y - from.y);
          if (remaining <= length) {
            const t = length === 0 ? 0 : remaining / length;
            ctx.beginPath();
            ctx.fillStyle = 'rgba(220, 250, 255, 0.95)';
            ctx.arc(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 3 / scale, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          remaining -= length;
        }
      }
    }
  }

  // Tails on the systems where the route leaves the bubble: "it continues, but
  // not here". Direction comes from the last hop travelled, which is the only
  // direction we honestly have — the next system has no position at all.
  const { exits } = routeBreaks(input.routeSystemIds, present);
  if (exits.length > 0) {
    ctx.strokeStyle = 'rgba(143, 233, 245, 0.8)';
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.lineWidth = 2 / scale;
    for (const systemId of exits) {
      const node = byId.get(systemId)!;
      const index = input.routeSystemIds.indexOf(systemId);
      const previous = index > 0 ? byId.get(input.routeSystemIds[index - 1]!) : undefined;
      if (!previous) continue;
      const dx = node.x - previous.x;
      const dy = node.y - previous.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(node.x + (dx / length) * 26, node.y + (dy / length) * 26);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/**
 * Узел: ядро цвета безопасности (как в клиенте), ореол цвета угрозы — только
 * там, где угроза есть. Размер ядра несёт PvP-активность за час.
 */
function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: RenderNode[],
  input: RenderInput,
  scale: number,
): void {
  ctx.save();
  for (const node of nodes) {
    const danger = node.system.danger;
    const activity = Math.min(1, node.system.activity.kills1h / 8);
    const radius = (3.2 + activity * 4.5) / scale;

    if (danger.band !== 'calm' && danger.score > 0.15) {
      const glow = ctx.createRadialGradient(node.x, node.y, radius, node.x, node.y, radius * 5);
      glow.addColorStop(0, withAlpha(bandColor(danger.band), 0.2 + danger.score * 0.35));
      glow.addColorStop(1, withAlpha(bandColor(danger.band), 0));
      ctx.beginPath();
      ctx.fillStyle = glow;
      ctx.arc(node.x, node.y, radius * 5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.fillStyle = securityColor(node.system.security);
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = 'rgba(3, 6, 10, 0.9)';
    ctx.stroke();

    if (node.system.gateCamps.some((camp) => camp.killCount >= 2)) {
      // Кемп — отдельный знак, а не оттенок: его нельзя пропустить взглядом.
      ctx.beginPath();
      ctx.strokeStyle = '#ff7f6e';
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([3 / scale, 2 / scale]);
      ctx.arc(node.x, node.y, radius + 5 / scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (node.systemId === input.selectedSystemId || node.systemId === input.hoveredSystemId) {
      ctx.beginPath();
      ctx.strokeStyle = node.systemId === input.selectedSystemId
        ? 'rgba(143, 233, 245, 0.95)'
        : 'rgba(226, 238, 245, 0.6)';
      ctx.lineWidth = 1.5 / scale;
      ctx.arc(node.x, node.y, radius + 8 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Тлеющие килы: каждый кил последнего часа — искра у своей системы. Яркость
 * гаснет с возрастом, размер несёт уничтоженную стоимость, соло и групповой
 * кил различаются формой. Так видно, где стреляют прямо сейчас, а где стреляли.
 */
function drawEmbers(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  const kills = input.bubble.recentKills;
  if (kills.length === 0) return;
  const scale = input.transform.k;
  ctx.save();
  for (const kill of kills) {
    if (kill.isNpc) continue;
    const node = byId.get(kill.systemId);
    if (!node) continue;
    const age = input.now - kill.killmailTimeMs;
    if (age < 0 || age > EMBER_WINDOW_MS) continue;
    const life = 1 - age / EMBER_WINDOW_MS;
    const seed = hash01(kill.killmailId);
    const angle = seed * Math.PI * 2;
    const orbit = (12 + seed * 8) / scale;
    const x = node.x + Math.cos(angle) * orbit;
    const y = node.y + Math.sin(angle) * orbit;
    const size = (1.6 + Math.min(3, Math.log10(Math.max(1, kill.totalValue)) - 6)) / scale;
    const flicker = input.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(input.now / 260 + seed * 20);
    const alpha = (0.25 + life * 0.75) * flicker;

    ctx.beginPath();
    ctx.fillStyle = `rgba(255, 127, 110, ${alpha})`;
    if (kill.isSolo) {
      ctx.arc(x, y, Math.max(size, 1.4 / scale), 0, Math.PI * 2);
    } else {
      // Групповой кил — ромб: в строю кил ощущается иначе, чем дуэль.
      const r = Math.max(size, 1.6 / scale) * 1.3;
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    }
    ctx.fill();

    // Первые пять минут кил ещё «горячий»: тонкая нить к системе.
    if (age < 5 * 60_000) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255, 127, 110, ${0.35 * life})`;
      ctx.lineWidth = 1 / scale;
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Вспышка на свежем киле. Живёт полторы секунды и гаснет — это уведомление о
 * событии, а не постоянный слой. При reduced-motion рисуется статичное кольцо.
 */
function drawFlashes(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.flashes.length === 0) return;
  ctx.save();
  for (const flash of input.flashes) {
    const node = byId.get(flash.systemId);
    if (!node) continue;
    const progress = flashProgress(flash, input.now, input.reducedMotion);
    if (progress === null) continue;
    const radius = (10 + progress * 44) / input.transform.k;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 127, 110, ${(1 - progress) * 0.95})`;
    ctx.lineWidth = (2.5 - progress * 1.5) / input.transform.k;
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Пилот — главный объект карты: прицельная рамка вокруг системы, а не ещё
 * одна точка. Пульсирует, только пока позиция живая; последняя известная
 * позиция рисуется неподвижной и приглушённой — она не должна выдавать себя
 * за живое движение.
 */
function drawPilot(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.pilotSystemId === null) return;
  const node = byId.get(input.pilotSystemId);
  if (!node) return;
  const scale = input.transform.k;
  const live = input.pilotOnline;
  const pulse = !live ? 0 : input.reducedMotion ? 0.5 : (Math.sin(input.now / 420) + 1) / 2;
  const colour = live ? '69, 211, 230' : '152, 169, 183';

  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = `rgba(${colour}, ${0.08 + pulse * 0.12})`;
  ctx.arc(node.x, node.y, (22 + pulse * 8) / scale, 0, Math.PI * 2);
  ctx.fill();

  // Уголки прицела: 4 скобки вокруг системы.
  const r = 15 / scale;
  const arm = 6 / scale;
  ctx.strokeStyle = `rgba(${colour}, 0.95)`;
  ctx.lineWidth = 2 / scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const cx = node.x + sx * r;
    const cy = node.y + sy * r;
    ctx.moveTo(cx - sx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - sy * arm);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = live ? '#8fe9f5' : '#98a9b7';
  ctx.arc(node.x, node.y, 4.5 / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5 / scale;
  ctx.strokeStyle = '#03060a';
  ctx.stroke();
  ctx.restore();
}

type LabelKind = 'pilot' | 'selected' | 'route' | 'danger' | 'plain';

/**
 * Подписи — последним слоем и с разбором коллизий: сначала то, что пилоту
 * нужно всегда (он сам, выбранная система, маршрут, опасные системы), потом
 * остальные, пока есть место. Раньше подписывалось всё подряд, и на средних
 * масштабах имена ложились друг на друга сплошной кашей.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  nodes: RenderNode[],
  input: RenderInput,
  width: number,
  height: number,
): void {
  if (!input.showLabels) return;
  const { transform } = input;
  const scale = transform.k;
  const route = new Set(input.routeSystemIds);
  const everything = scale >= LABEL_ZOOM_THRESHOLD;

  const kindOf = (node: RenderNode): LabelKind => {
    if (node.systemId === input.pilotSystemId) return 'pilot';
    if (node.systemId === input.selectedSystemId || node.systemId === input.hoveredSystemId) return 'selected';
    if (route.has(node.systemId)) return 'route';
    const band = node.system.danger.band;
    if (band === 'hostile' || band === 'lethal' || band === 'elevated'
      || node.system.gateCamps.some((camp) => camp.killCount >= 2)) return 'danger';
    return 'plain';
  };
  const rank: Record<LabelKind, number> = { pilot: 0, selected: 1, route: 2, danger: 3, plain: 4 };

  const candidates = nodes
    .map((node) => ({ node, kind: kindOf(node) }))
    .filter((entry) => everything || entry.kind !== 'plain')
    .sort((a, b) => rank[a.kind] - rank[b.kind]
      || b.node.system.activity.kills1h - a.node.system.activity.kills1h);

  // Разбор коллизий в экранных координатах: подпись одинакового размера на
  // любом зуме, поэтому и проверять её надо на экране, а не в мире.
  ctx.save();
  ctx.setTransform(ctx.getTransform().scale(1 / scale, 1 / scale).translate(-transform.x, -transform.y));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const placed: Array<[number, number, number, number]> = [];
  const overlaps = (box: [number, number, number, number]): boolean => placed.some((other) => (
    box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]
  ));

  for (const { node, kind } of candidates) {
    const sx = transform.x + node.x * scale;
    const sy = transform.y + node.y * scale;
    if (sx < -80 || sy < -40 || sx > width + 80 || sy > height + 40) continue;
    const pilot = kind === 'pilot';
    const text = pilot && input.pilotLabel ? input.pilotLabel : node.system.name;
    const strong = kind !== 'plain';
    ctx.font = strong
      ? `600 ${pilot ? 12.5 : 11.5}px "Exo 2", "IBM Plex Sans", system-ui, sans-serif`
      : '11px "IBM Plex Sans", system-ui, sans-serif';
    const textWidth = ctx.measureText(text).width;
    const offset = pilot ? 22 : 9;
    const box: [number, number, number, number] = [
      sx - textWidth / 2 - 3, sy + offset - 2, sx + textWidth / 2 + 3, sy + offset + 14,
    ];
    if (kind !== 'pilot' && kind !== 'selected' && overlaps(box)) continue;
    placed.push(box);

    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(2, 5, 9, 0.92)';
    ctx.strokeText(text, sx, sy + offset);
    ctx.fillStyle = pilot
      ? (input.pilotOnline ? '#8fe9f5' : '#c9d6df')
      : kind === 'selected' ? '#eef6fa'
      : kind === 'route' ? '#bff3fa'
      : kind === 'danger' ? '#ffb0a4'
      : 'rgba(201, 214, 223, 0.72)';
    ctx.fillText(text, sx, sy + offset);
  }
  ctx.restore();
}

/** Детерминированный псевдослучай 0..1 из целого — стабильная фаза без мерцания между кадрами. */
function hash01(value: number): number {
  let x = Math.imul(value | 0, 0x9e3779b1) ^ 0x85ebca6b;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
