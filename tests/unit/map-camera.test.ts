import { describe, expect, it } from 'vitest';
import {
  cameraTargetFor,
  easeToward,
  isSettled,
  pruneJumpTimes,
  MOTION_WINDOW_MS,
  type CameraTarget,
} from '../../web/src/components/map/camera.js';

/**
 * Поведение камеры невозможно проверить в браузерном прогоне: панель держит
 * страницу скрытой, а браузер глушит requestAnimationFrame на скрытой вкладке,
 * и доводка просто не идёт. Поэтому математика вынесена из компонента и
 * проверяется здесь.
 */
const NOW = 1_700_000_000_000;

describe('camera target', () => {
  it('centres the pilot in the viewport', () => {
    const target = cameraTargetFor({
      width: 800, height: 600, pilot: { x: 0, y: 0 }, jumpTimes: [], now: NOW,
    })!;
    // Пилот в мировом нуле должен оказаться ровно в центре холста.
    expect(target.x).toBe(400);
    expect(target.y).toBe(300);
  });

  it('offsets by the pilot position scaled', () => {
    const target = cameraTargetFor({
      width: 800, height: 600, pilot: { x: 100, y: -50 }, jumpTimes: [], now: NOW,
    })!;
    expect(target.x).toBeCloseTo(400 - 100 * target.k, 6);
    expect(target.y).toBeCloseTo(300 + 50 * target.k, 6);
  });

  it('zooms out while jumps keep arriving and back in when parked', () => {
    const moving = cameraTargetFor({
      width: 800, height: 600, pilot: { x: 0, y: 0 },
      jumpTimes: [NOW - 1000, NOW - 20_000], now: NOW,
    })!;
    const parked = cameraTargetFor({
      width: 800, height: 600, pilot: { x: 0, y: 0 },
      jumpTimes: [NOW - 1000], now: NOW,
    })!;
    expect(moving.k).toBeLessThan(parked.k);
  });

  it('treats jumps older than the motion window as parked', () => {
    const target = cameraTargetFor({
      width: 800, height: 600, pilot: { x: 0, y: 0 },
      jumpTimes: [NOW - MOTION_WINDOW_MS - 1, NOW - MOTION_WINDOW_MS - 2], now: NOW,
    })!;
    const parked = cameraTargetFor({
      width: 800, height: 600, pilot: { x: 0, y: 0 }, jumpTimes: [], now: NOW,
    })!;
    expect(target.k).toBe(parked.k);
  });

  it('refuses to move the camera when there is nothing to follow', () => {
    // Все три случая иначе увели бы камеру в мировой ноль.
    expect(cameraTargetFor({ width: 0, height: 600, pilot: { x: 0, y: 0 }, jumpTimes: [], now: NOW })).toBeNull();
    expect(cameraTargetFor({ width: 800, height: 0, pilot: { x: 0, y: 0 }, jumpTimes: [], now: NOW })).toBeNull();
    expect(cameraTargetFor({ width: 800, height: 600, pilot: null, jumpTimes: [], now: NOW })).toBeNull();
  });
});

describe('camera easing', () => {
  const start: CameraTarget = { x: 0, y: 0, k: 1 };
  const target: CameraTarget = { x: 400, y: 300, k: 1.1 };

  it('snaps in a single step for reduced motion', () => {
    expect(easeToward(start, target, 1)).toEqual(target);
  });

  it('converges to the target and then reports settled', () => {
    let current = start;
    for (let frame = 0; frame < 200; frame += 1) {
      if (isSettled(current, target)) break;
      current = easeToward(current, target, 0.14);
    }
    expect(isSettled(current, target)).toBe(true);
    expect(current.x).toBeCloseTo(target.x, 0);
    expect(current.y).toBeCloseTo(target.y, 0);
    expect(current.k).toBeCloseTo(target.k, 3);
  });

  it('reaches the target within a second of frames', () => {
    let current = start;
    let frames = 0;
    while (!isSettled(current, target) && frames < 300) {
      current = easeToward(current, target, 0.14);
      frames += 1;
    }
    // Доводка должна ощущаться мгновенной, а не как отдельная поездка.
    expect(frames).toBeLessThanOrEqual(60);
  });

  it('is not settled while the pilot is still off-centre', () => {
    expect(isSettled(start, target)).toBe(false);
  });
});

describe('jump time pruning', () => {
  it('drops jumps outside the motion window', () => {
    const pruned = pruneJumpTimes(
      [NOW - MOTION_WINDOW_MS - 1, NOW - 1000, NOW - 5000],
      NOW,
    );
    expect(pruned).toEqual([NOW - 1000, NOW - 5000]);
  });

  it('keeps the list from growing over a long flight', () => {
    const times: number[] = [];
    for (let index = 0; index < 500; index += 1) times.push(NOW - index * 1000);
    expect(pruneJumpTimes(times, NOW).length).toBeLessThan(times.length);
  });
});
