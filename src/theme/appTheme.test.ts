import { describe, expect, it } from 'vitest';
import { getPaletteTokens, makeTheme } from './appTheme';

describe('application theme', () => {
  it('uses Sky Blue as the light-mode default accent', () => {
    expect(makeTheme('sky', 'light').palette.primary.main).toBe('#1F6E90');
  });

  it('keeps primary button text at WCAG AA contrast in light mode', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const name of ['sky', 'mint', 'graphite'] as const) {
      const background = luminance(getPaletteTokens(name).primary);
      expect(1.05 / (background + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps palette identity in dark mode', () => {
    expect(makeTheme('mint', 'dark').palette.primary.main).toBe('#6FD0BF');
    expect(makeTheme('graphite', 'dark').palette.primary.main).toBe('#9DB2C6');
    expect(makeTheme('mint', 'dark').palette.background.default).not.toBe(makeTheme('sky', 'dark').palette.background.default);
  });
});
