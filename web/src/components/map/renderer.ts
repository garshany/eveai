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
  selectedSystemId: number | null;
  hoveredSystemId: number | null;
  routeSystemIds: number[];
  flashes: KillFlash[];
  showLabels: boolean;
  now: number;
  reducedMotion: boolean;
};

const FLASH_MS = 1600;
const LABEL_ZOOM_THRESHOLD = 0.55;
const RING_COLOR = 'rgba(148, 163, 184, 0.14)';

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
  drawWormholes(ctx, input, byId);
  drawRoute(ctx, input, byId);
  drawNodes(ctx, nodes, input, transform.k);
  drawFlashes(ctx, input, byId);
  drawPilot(ctx, input, byId);

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
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
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

function drawRoute(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.routeSystemIds.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
  ctx.lineWidth = 3 / input.transform.k;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  for (const systemId of input.routeSystemIds) {
    const node = byId.get(systemId);
    if (!node) continue;
    if (started) ctx.lineTo(node.x, node.y);
    else {
      ctx.moveTo(node.x, node.y);
      started = true;
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: RenderNode[],
  input: RenderInput,
  scale: number,
): void {
  const labels = input.showLabels && scale >= LABEL_ZOOM_THRESHOLD;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `${11 / scale}px "IBM Plex Sans", system-ui, sans-serif`;

  for (const node of nodes) {
    const danger = node.system.danger;
    // Радиус несёт активность, цвет — опасность: тихая красная система и
    // шумная жёлтая должны выглядеть по-разному.
    const activity = Math.min(1, node.system.activity.kills1h / 8);
    const radius = (4 + activity * 5) / scale;

    if (danger.score > 0.25) {
      ctx.beginPath();
      ctx.fillStyle = withAlpha(bandColor(danger.band), 0.12 + danger.score * 0.18);
      ctx.arc(node.x, node.y, radius * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.fillStyle = bandColor(danger.band);
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (node.system.gateCamps.some((camp) => camp.killCount >= 2)) {
      // Кемп — отдельный знак, а не оттенок: его нельзя пропустить взглядом.
      ctx.beginPath();
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1.5 / scale;
      ctx.arc(node.x, node.y, radius * 1.9, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (node.systemId === input.selectedSystemId || node.systemId === input.hoveredSystemId) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.9)';
      ctx.lineWidth = 1.5 / scale;
      ctx.arc(node.x, node.y, radius * 2.4, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (labels) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.82)';
      ctx.fillText(node.system.name, node.x, node.y + radius + 3 / scale);
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
    const age = input.now - flash.startedAt;
    if (age > FLASH_MS) continue;
    const progress = input.reducedMotion ? 0.5 : age / FLASH_MS;
    const radius = (10 + progress * 34) / input.transform.k;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(248, 113, 113, ${(1 - progress) * 0.9})`;
    ctx.lineWidth = 2 / input.transform.k;
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPilot(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  byId: Map<number, RenderNode>,
): void {
  if (input.pilotSystemId === null) return;
  const node = byId.get(input.pilotSystemId);
  if (!node) return;
  const scale = input.transform.k;

  // Пульсация как признак «поток жив»: замерший маркер сразу читается как
  // потерянное соединение.
  // A logged-out pilot gets a still, dimmer marker: the pulse is what says
  // "this is live", and a last-known position must not claim that.
  const pulse = !input.pilotOnline ? 0 : input.reducedMotion ? 0.5 : (Math.sin(input.now / 420) + 1) / 2;
  const colour = input.pilotOnline ? '56, 189, 248' : '148, 163, 184';
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = `rgba(${colour}, ${0.12 + pulse * 0.15})`;
  ctx.arc(node.x, node.y, (14 + pulse * 6) / scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = input.pilotOnline ? '#38bdf8' : '#94a3b8';
  ctx.arc(node.x, node.y, 6 / scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2 / scale;
  ctx.arc(node.x, node.y, 6 / scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
