import { createTheme, type PaletteMode } from '@mui/material/styles';
import type { PaletteName } from '../domain/contracts';

/**
 * Token values mirrored for MUI's own palette object. The CSS side lives in
 * `src/styles/tokens.css`; both must stay in sync — that file is authoritative
 * for rendering, this one for MUI's internal colour maths (contrast, ripples,
 * aria-driven variants).
 */
interface PaletteTokens {
  light: { primary: string; strong: string; soft: string; wash: string };
  dark: { primary: string; strong: string; soft: string; wash: string; canvas: string; surface: string };
  background: string;
  paper: string;
  text: string;
  muted: string;
}

const NEUTRAL = {
  canvas: '#F3F3F5',
  surface: '#FFFFFF',
  ink: '#111113',
  ink2: '#4C4C55',
  ink3: '#83838D',
  line: '#E8E8EA',
  line2: '#DCDCE0',
};

const tokens: Record<PaletteName, PaletteTokens> = {
  sky: {
    light: { primary: '#1F6E90', strong: '#175872', soft: '#EEF3F6', wash: '#F6F9FA' },
    dark: { primary: '#6CB6D6', strong: '#93CDE5', soft: 'rgba(108,182,214,0.14)', wash: 'rgba(108,182,214,0.07)', canvas: '#0C0D0F', surface: '#161719' },
    background: '#F1F3F6',
    paper: NEUTRAL.surface,
    text: NEUTRAL.ink,
    muted: NEUTRAL.ink2,
  },
  mint: {
    light: { primary: '#136B5F', strong: '#0E5348', soft: '#ECF4F2', wash: '#F5FAF8' },
    dark: { primary: '#6FD0BF', strong: '#96DDD0', soft: 'rgba(111,208,191,0.14)', wash: 'rgba(111,208,191,0.07)', canvas: '#0B0F0E', surface: '#151917' },
    background: '#EFF4F1',
    paper: NEUTRAL.surface,
    text: NEUTRAL.ink,
    muted: NEUTRAL.ink2,
  },
  graphite: {
    light: { primary: '#3F5265', strong: '#2E3F4F', soft: '#EEF1F4', wash: '#F7F8FA' },
    dark: { primary: '#9DB2C6', strong: '#C2D2E0', soft: 'rgba(157,178,198,0.14)', wash: 'rgba(157,178,198,0.07)', canvas: '#0C0D10', surface: '#16171B' },
    background: '#F1F2F4',
    paper: NEUTRAL.surface,
    text: NEUTRAL.ink,
    muted: NEUTRAL.ink2,
  },
};

const DARK = {
  canvas: '#0C0D0F',
  surface: '#161719',
  surface2: '#1B1C1F',
  ink: '#F4F4F6',
  ink2: '#B3B3BC',
  ink3: '#84848D',
  line: 'rgba(255,255,255,0.085)',
  line2: 'rgba(255,255,255,0.14)',
};

export function makeTheme(paletteName: PaletteName, mode: PaletteMode) {
  const token = tokens[paletteName];
  const dark = mode === 'dark';
  const accent = dark ? token.dark.primary : token.light.primary;
  const line = dark ? DARK.line : NEUTRAL.line;
  const line2 = dark ? DARK.line2 : NEUTRAL.line2;

  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: {
        main: accent,
        dark: dark ? token.dark.strong : token.light.strong,
        light: dark ? token.dark.soft : token.light.soft,
        contrastText: dark ? '#0C0D0F' : '#FFFFFF',
      },
      secondary: { main: dark ? '#A7A4D8' : '#63628C' },
      success: { main: dark ? '#4EC9A0' : '#12805C' },
      warning: { main: dark ? '#E0B062' : '#A86412' },
      error: { main: dark ? '#EF8080' : '#C43D3D' },
      info: { main: accent },
      background: { default: dark ? token.dark.canvas : token.background, paper: dark ? token.dark.surface : token.paper },
      text: { primary: dark ? DARK.ink : token.text, secondary: dark ? DARK.ink2 : token.muted, disabled: dark ? DARK.ink3 : NEUTRAL.ink3 },
      divider: line,
      action: {
        hover: dark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,19,0.045)',
        selected: dark ? 'rgba(255,255,255,0.09)' : 'rgba(17,17,19,0.06)',
        disabled: dark ? DARK.ink3 : NEUTRAL.ink3,
        disabledBackground: dark ? DARK.surface2 : '#E8E8EB',
      },
    },
    typography: {
      fontFamily: 'var(--font-sans)',
      fontSize: 15,
      h1: { fontSize: 'var(--fs-28)', fontWeight: 600, lineHeight: 'var(--lh-tight)', letterSpacing: 'var(--ls-normal)' },
      h2: { fontSize: 'var(--fs-20)', fontWeight: 600, lineHeight: 'var(--lh-snug)', letterSpacing: 'var(--ls-normal)' },
      h3: { fontSize: 'var(--fs-17)', fontWeight: 600, lineHeight: 'var(--lh-snug)', letterSpacing: 'var(--ls-normal)' },
      h4: { fontSize: 'var(--fs-15)', fontWeight: 600, lineHeight: 'var(--lh-snug)' },
      subtitle1: { fontSize: 'var(--fs-15)', fontWeight: 600 },
      subtitle2: { fontSize: 'var(--fs-14)', fontWeight: 500 },
      body1: { fontSize: 'var(--fs-15)', lineHeight: 'var(--lh-normal)' },
      body2: { fontSize: 'var(--fs-14)', lineHeight: 'var(--lh-normal)' },
      caption: { fontSize: 'var(--fs-13)', lineHeight: 'var(--lh-snug)' },
      overline: { fontSize: 'var(--fs-12)', fontWeight: 600, letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase' },
      button: { textTransform: 'none', fontWeight: 500, letterSpacing: 0, fontSize: 'var(--fs-14)' },
    },
    shape: { borderRadius: 12 },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundColor: dark ? token.dark.canvas : token.background },
          '*:focus-visible': { outline: `2px solid ${accent}`, outlineOffset: 2 },
        },
      },

      MuiButtonBase: {
        // Material ripples read as a framework demo, not a product.
        defaultProps: { disableRipple: true },
      },

      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            minHeight: 40,
            paddingInline: 16,
            borderRadius: 'var(--r-sm)',
            fontSize: 'var(--fs-14)',
            fontWeight: 500,
            lineHeight: 1.2,
            letterSpacing: 0,
            textTransform: 'none',
            transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
          },
          sizeSmall: { minHeight: 32, paddingInline: 12, fontSize: 'var(--fs-13)' },
          sizeLarge: { minHeight: 44, paddingInline: 20, fontSize: 'var(--fs-15)' },
          startIcon: { marginRight: 8, marginLeft: 0, '& > *:nth-of-type(1)': { fontSize: '1.15em' } },
          endIcon: { marginLeft: 8, marginRight: 0, '& > *:nth-of-type(1)': { fontSize: '1.15em' } },
          contained: {
            color: 'var(--c-action-ink)',
            backgroundColor: 'var(--c-action)',
            boxShadow: 'none',
            '&:hover': { backgroundColor: 'var(--c-action-hover)', boxShadow: 'none' },
            '&:active': { backgroundColor: 'var(--c-action-hover)' },
            '&.Mui-disabled': { color: 'var(--c-ink-4)', backgroundColor: 'var(--c-surface-4)', opacity: 1 },
          },
          outlined: {
            color: 'var(--c-ink)',
            backgroundColor: 'var(--c-surface)',
            borderColor: 'var(--c-line-2)',
            '&:hover': { backgroundColor: 'var(--c-surface-2)', borderColor: 'var(--c-line-3)' },
            '&.Mui-disabled': { color: 'var(--c-ink-4)', borderColor: 'var(--c-line)', backgroundColor: 'transparent' },
          },
          text: {
            color: 'var(--c-ink-2)',
            '&:hover': { backgroundColor: 'var(--c-surface-3)', color: 'var(--c-ink)' },
          },
        },
      },

      MuiIconButton: {
        styleOverrides: {
          root: {
            color: 'var(--c-ink-3)',
            borderRadius: 'var(--r-xs)',
            transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
            '&:hover': { backgroundColor: 'var(--c-surface-3)', color: 'var(--c-ink)' },
            '&.Mui-disabled': { color: 'var(--c-ink-4)' },
          },
          sizeSmall: { padding: 6, '& .MuiSvgIcon-root': { fontSize: 18 } },
        },
      },

      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          rounded: { borderRadius: 'var(--r-md)' },
        },
      },

      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            border: `1px solid ${line}`,
            borderRadius: 'var(--r-md)',
            backgroundImage: 'none',
            boxShadow: 'none',
          },
        },
      },

      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--r-sm)',
            backgroundColor: 'var(--c-surface)',
            fontSize: 'var(--fs-14)',
            transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
            '& .MuiOutlinedInput-notchedOutline': { borderColor: line2 },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--c-line-3)' },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: accent, borderWidth: 1.5 },
            '&.Mui-focused': { boxShadow: `0 0 0 3px color-mix(in srgb, ${accent} 12%, transparent)` },
          },
          input: { paddingBlock: 10, paddingInline: 12 },
        },
      },

      MuiInputLabel: {
        styleOverrides: { root: { fontSize: 'var(--fs-13)', color: 'var(--c-ink-3)' } },
      },

      MuiFormHelperText: {
        styleOverrides: { root: { fontSize: 'var(--fs-12)', marginLeft: 2, marginTop: 4 } },
      },

      MuiChip: {
        styleOverrides: {
          root: {
            height: 24,
            borderRadius: 'var(--r-full)',
            backgroundColor: 'var(--c-surface-3)',
            color: 'var(--c-ink-2)',
            fontSize: 'var(--fs-12)',
            fontWeight: 500,
            border: 'none',
          },
          label: { paddingInline: 10 },
          sizeSmall: { height: 21, fontSize: 'var(--fs-12)', '& .MuiChip-label': { paddingInline: 8 } },
          outlined: { backgroundColor: 'transparent', border: `1px solid ${line2}` },
          colorSuccess: { backgroundColor: 'var(--c-success-soft)', color: 'var(--c-success)' },
          colorWarning: { backgroundColor: 'var(--c-warning-soft)', color: 'var(--c-warning)' },
          colorError: { backgroundColor: 'var(--c-danger-soft)', color: 'var(--c-danger)' },
          colorInfo: { backgroundColor: 'var(--brand-soft)', color: 'var(--brand-ink)' },
        },
      },

      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--r-sm)',
            border: `1px solid ${line}`,
            backgroundColor: 'var(--c-surface-2)',
            color: 'var(--c-ink-2)',
            fontSize: 'var(--fs-14)',
            padding: '10px 14px',
            alignItems: 'center',
            '& .MuiAlert-icon': { color: 'var(--c-ink-3)', fontSize: 20, marginRight: 10, padding: 0 },
            '& .MuiAlert-message': { padding: 0, fontSize: 'var(--fs-14)', lineHeight: 1.5 },
            '& .MuiAlert-action': { padding: 0, alignItems: 'center' },
          },
          standardSuccess: { '& .MuiAlert-icon': { color: 'var(--c-success)' } },
          standardWarning: { '& .MuiAlert-icon': { color: 'var(--c-warning)' } },
          standardError: { '& .MuiAlert-icon': { color: 'var(--c-danger)' }, borderColor: 'color-mix(in srgb, var(--c-danger) 24%, var(--c-line))' },
          standardInfo: { '& .MuiAlert-icon': { color: 'var(--brand)' } },
        },
      },

      MuiTooltip: {
        defaultProps: { arrow: false },
        styleOverrides: {
          tooltip: {
            backgroundColor: dark ? '#F4F4F6' : '#111113',
            color: dark ? '#111113' : '#FFFFFF',
            borderRadius: 'var(--r-xs)',
            fontSize: 'var(--fs-12)',
            fontWeight: 500,
            padding: '5px 8px',
            boxShadow: 'var(--sh-2)',
          },
        },
      },

      MuiMenu: {
        styleOverrides: {
          paper: {
            marginTop: 6,
            borderRadius: 'var(--r-sm)',
            border: `1px solid ${line}`,
            boxShadow: 'var(--sh-3)',
            padding: 4,
            minWidth: 180,
          },
          list: { padding: 0 },
        },
      },

      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: 36,
            borderRadius: 'var(--r-xs)',
            fontSize: 'var(--fs-14)',
            gap: 8,
            paddingInline: 10,
            '&:hover': { backgroundColor: 'var(--c-surface-3)' },
            '&.Mui-selected': { backgroundColor: 'var(--c-surface-3)', fontWeight: 500 },
            '&.Mui-selected:hover': { backgroundColor: 'var(--c-surface-4)' },
            '&.Mui-disabled': { opacity: 0.55 },
          },
        },
      },

      MuiPopover: {
        styleOverrides: { paper: { borderRadius: 'var(--r-md)', border: `1px solid ${line}`, boxShadow: 'var(--sh-3)' } },
      },

      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: 'var(--r-lg)', border: `1px solid ${line}`, boxShadow: 'var(--sh-3)', backgroundImage: 'none' },
          root: { backdropFilter: 'blur(2px)' },
        },
      },

      MuiDialogTitle: {
        styleOverrides: { root: { fontSize: 'var(--fs-17)', fontWeight: 600, padding: '20px 24px 4px' } },
      },

      MuiDialogContent: {
        styleOverrides: { root: { padding: '12px 24px', fontSize: 'var(--fs-14)' } },
      },

      MuiDialogActions: {
        styleOverrides: { root: { padding: '12px 24px 20px', gap: 8 } },
      },

      MuiDivider: {
        styleOverrides: { root: { borderColor: line } },
      },

      MuiSwitch: {
        styleOverrides: {
          root: { padding: 8 },
          track: { borderRadius: 'var(--r-full)', backgroundColor: 'var(--c-line-3)' },
          thumb: { boxShadow: 'var(--sh-1)' },
        },
      },

      MuiCheckbox: {
        styleOverrides: { root: { borderRadius: 6, padding: 6, color: 'var(--c-line-3)' } },
      },

      MuiRadio: {
        styleOverrides: { root: { padding: 6, color: 'var(--c-line-3)' } },
      },

      MuiLinearProgress: {
        styleOverrides: {
          root: { height: 6, borderRadius: 'var(--r-full)', backgroundColor: 'var(--c-surface-4)' },
          bar: { borderRadius: 'var(--r-full)', backgroundColor: accent },
        },
      },

      MuiCircularProgress: {
        styleOverrides: { root: { color: accent } },
      },

      MuiSelect: {
        styleOverrides: { select: { fontSize: 'var(--fs-14)', minHeight: 'auto' } },
      },

      MuiTabs: {
        styleOverrides: { indicator: { height: 2, borderRadius: 2, backgroundColor: 'var(--c-ink)' } },
      },

      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontSize: 'var(--fs-14)',
            fontWeight: 500,
            minHeight: 40,
            paddingInline: 12,
            color: 'var(--c-ink-3)',
            '&.Mui-selected': { color: 'var(--c-ink)' },
          },
        },
      },

      MuiDrawer: {
        styleOverrides: { paper: { border: 'none', boxShadow: 'var(--sh-3)' } },
      },

      MuiTypography: {
        styleOverrides: { root: { '&[color="text.secondary"]': { color: 'var(--c-ink-2)' } } },
      },
    },
  });
}

/**
 * Raw palette identity for tests and for anywhere that needs the plain colour
 * rather than a themed component.
 */
export function getPaletteTokens(paletteName: PaletteName) {
  const token = tokens[paletteName];
  return {
    primary: token.light.primary,
    strong: token.light.strong,
    soft: token.light.soft,
    wash: token.light.wash,
    background: token.background,
    paper: token.paper,
    text: token.text,
    muted: token.muted,
    darkPrimary: token.dark.primary,
    darkStrong: token.dark.strong,
    darkSoft: token.dark.soft,
    darkBackground: token.dark.canvas,
    darkPaper: token.dark.surface,
  };
}
