import { describe, expect, it } from 'vitest';
import { SwipeRecognizer } from './swipe';

const mk = () => new SwipeRecognizer({ threshold: 20 });

describe('SwipeRecognizer', () => {
  it('ignores moves before begin and small jitter', () => {
    const s = mk();
    expect(s.move(50, 50)).toBeNull();
    s.begin(100, 100);
    expect(s.move(110, 105)).toBeNull();
    expect(s.move(95, 112)).toBeNull();
  });

  it('fires the moment the threshold is crossed, not on release', () => {
    const s = mk();
    s.begin(100, 100);
    expect(s.move(90, 100)).toBeNull();
    expect(s.move(79, 101)).toBe('left');
    expect(s.tracking).toBe(true);
  });

  it('detects all four directions', () => {
    const dirs = [
      [130, 100, 'right'],
      [70, 100, 'left'],
      [100, 70, 'up'],
      [100, 130, 'down'],
    ] as const;
    for (const [x, y, d] of dirs) {
      const s = mk();
      s.begin(100, 100);
      expect(s.move(x, y)).toBe(d);
    }
  });

  it('picks the dominant axis for diagonals', () => {
    const s = mk();
    s.begin(0, 0);
    expect(s.move(25, -40)).toBe('up');
  });

  it('does not repeat while dragging further in the same direction', () => {
    const s = mk();
    s.begin(0, 0);
    expect(s.move(-25, 0)).toBe('left');
    expect(s.move(-60, 0)).toBeNull();
    expect(s.move(-200, 3)).toBeNull();
  });

  it('supports a second swipe in the same touch after re-centering (left then up)', () => {
    const s = mk();
    s.begin(200, 300);
    expect(s.move(170, 300)).toBe('left');
    expect(s.move(168, 290)).toBeNull();
    expect(s.move(166, 270)).toBe('up');
  });

  it('allows a reversal once it travels the threshold back from the extreme', () => {
    const s = mk();
    s.begin(0, 0);
    expect(s.move(-30, 0)).toBe('left');
    expect(s.move(-80, 0)).toBeNull();
    expect(s.move(-70, 0)).toBeNull();
    expect(s.move(-55, 0)).toBe('right');
  });

  it('starts fresh after end/begin', () => {
    const s = mk();
    s.begin(0, 0);
    expect(s.move(30, 0)).toBe('right');
    s.end();
    expect(s.move(80, 0)).toBeNull();
    s.begin(80, 0);
    expect(s.move(110, 0)).toBe('right');
  });

  it('stops tracking after end', () => {
    const s = mk();
    s.begin(0, 0);
    s.end();
    expect(s.move(100, 0)).toBeNull();
    expect(s.tracking).toBe(false);
  });
});
