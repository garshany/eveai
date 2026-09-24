/**
 * Камера «Периметра».
 *
 * Вынесено из компонента отдельной чистой функцией по одной причине: поведение
 * камеры невозможно проверить глазами в автоматическом прогоне — браузер глушит
 * requestAnimationFrame, когда вкладка скрыта, и доводка просто не идёт. Здесь
 * же считается ровно то, «куда камера хочет попасть», и это проверяется тестом.
 */

export type CameraTarget = { x: number; y: number; k: number };

/** Прыжки за это окно считаются признаком «пилот в движении». */
export const MOTION_WINDOW_MS = 45_000;
/** Сколько прыжков в окне включают отъезд камеры. */
export const MOTION_JUMPS = 2;

const SCALE_MOVING = 0.55;
const SCALE_PARKED = 1.1;
/** Не мельче этого камера показывает систему, к которой её попросили отвезти. */
const FOCUS_MIN_SCALE = 0.8;

/**
 * Куда камера должна приехать. Возвращает null, когда следовать не за чем:
 * нет размера холста, неизвестен пилот, или его системы нет в раскладке —
 * во всех трёх случаях камеру трогать нельзя, иначе она уедет в ноль.
 */
export function cameraTargetFor(input: {
  width: number;
  height: number;
  /** Позиция пилота в мировых координатах раскладки. */
  pilot: { x: number; y: number } | null;
  /** Времена последних прыжков, любой давности — фильтрация здесь. */
  jumpTimes: readonly number[];
  now: number;
}): CameraTarget | null {
  if (input.width <= 0 || input.height <= 0 || !input.pilot) return null;

  // Автозум: пока прыжки идут часто, отъезжаем, чтобы было видно больше пути
  // впереди; на стоянке возвращаемся ближе — так ведёт себя навигатор.
  const recent = input.jumpTimes.filter((time) => input.now - time < MOTION_WINDOW_MS);
  const k = recent.length >= MOTION_JUMPS ? SCALE_MOVING : SCALE_PARKED;

  return {
    k,
    x: input.width / 2 - input.pilot.x * k,
    y: input.height / 2 - input.pilot.y * k,
  };
}

/** Отбрасывает прыжки, вышедшие из окна движения, чтобы список не рос вечно. */
export function pruneJumpTimes(jumpTimes: number[], now: number): number[] {
  return jumpTimes.filter((time) => now - time < MOTION_WINDOW_MS);
}

/**
 * Один шаг доводки. `step` = 1 означает мгновенный переход — это путь для
 * prefers-reduced-motion, и он же делает поведение проверяемым без анимации.
 */
export function easeToward(
  current: CameraTarget,
  target: CameraTarget,
  step: number,
): CameraTarget {
  return {
    x: current.x + (target.x - current.x) * step,
    y: current.y + (target.y - current.y) * step,
    k: current.k + (target.k - current.k) * step,
  };
}

/** Доводка закончена: дальше двигать камеру бессмысленно и заметно не будет. */
export function isSettled(current: CameraTarget, target: CameraTarget): boolean {
  return Math.abs(target.x - current.x) <= 0.5
    && Math.abs(target.y - current.y) <= 0.5
    && Math.abs(target.k - current.k) <= 0.001;
}

/**
 * Куда везти камеру, когда пилот попросил показать систему (якорь совета,
 * «на карте»): центр экрана на точке, масштаб не меньше читаемого. Без этого
 * клик по якорю только выделял систему, а камера оставалась где была — часто
 * с выделением за краем экрана.
 */
export function focusTargetFor(input: {
  width: number;
  height: number;
  point: { x: number; y: number } | null;
  /** Текущий масштаб: приближать сильнее нужного не надо, отдалять — тоже. */
  k: number;
}): CameraTarget | null {
  if (input.width <= 0 || input.height <= 0 || !input.point) return null;
  const k = Math.max(input.k, FOCUS_MIN_SCALE);
  return {
    k,
    x: input.width / 2 - input.point.x * k,
    y: input.height / 2 - input.point.y * k,
  };
}
