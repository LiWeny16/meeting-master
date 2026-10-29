# Meeting Master UI Design System

This is the authoritative, enforced reference for product UI work. It replaces the
informal per-page styling that accumulated before. If a rule here conflicts with an
older stylesheet, this document and `src/styles/tokens.css` win.

## 1. Why this exists

The previous UI grew by appending one value per problem: 22 distinct border radii,
94 hard-coded colours, 209 declarations of `font-size: 12px`, and a whole-app total of
two elements carrying a shadow. That is what "not enterprise-grade" actually means —
not an ugly colour, but **no consistent rules**. Premium interfaces look expensive
because they repeat a very small vocabulary with high precision.

Our two measurable targets, taken from the reference products we compare against:

| Metric | Target |
|---|---|
| Neutral (uncoloured) area share | ≥ 90 % of painted pixels |
| Brand-colour area share | ≤ 5 % (state, selection, focus only) |
| Distinct radii in use | 5 |
| Distinct font sizes in use | ≤ 8 |
| Cards carrying elevation | every floating surface; inner groups use tint, not shadow |

## 2. Sources of truth

```
src/styles/tokens.css      design tokens + base element styles   (do not redefine)
src/styles.css             shared primitives                     (consume only)
src/styles/shell.css       app frame: titlebar, sidebar, rail column
src/styles/chat-rail.css   assistant panel
src/styles/<page>.css      one page domain each
```

`src/theme/appTheme.ts` mirrors the tokens for MUI internals. Component defaults
(button variants, inputs, chips, menus, dialogs, alerts) are already centralised
there — **do not restyle these per page.** If a control needs to look different
globally, change the theme, not the page.

## 3. Tokens

### Colour — use these names only

| Token | Meaning |
|---|---|
| `--c-canvas` | app background behind the cards |
| `--c-surface` | card / panel surface |
| `--c-surface-2` | quiet inner group, table stripe, secondary panel |
| `--c-surface-3` | control track, hover fill, chip background |
| `--c-surface-4` | pressed / disabled fill |
| `--c-ink` | primary text, headings |
| `--c-ink-2` | body text |
| `--c-ink-3` | secondary text, metadata, captions |
| `--c-ink-4` | placeholder, disabled text, decorative icons |
| `--c-line` | hairline border / divider |
| `--c-line-2` | input border |
| `--c-line-3` | strong border / scrollbar thumb |
| `--c-action` `--c-action-hover` `--c-action-ink` | primary action (near-black, inverts in dark mode) |
| `--brand` `--brand-strong` `--brand-ink` `--brand-soft` | state, selection, focus, links |
| `--c-success` `--c-warning` `--c-danger` (+ `*-soft`) | semantic state, icon and dot only |

**Hard rules**

- Never write a raw hex value in a page stylesheet.
- Never paint a large area with `--brand`. Selected navigation, focus rings and
  status dots are the intended uses.
- The primary button is **near-black**, never brand-coloured.
- Disabled is neutral grey. A disabled control must never be red, brand-coloured,
  or lower-contrast tinted.

### Type

`--fs-11 --fs-12 --fs-13 --fs-14 --fs-15 --fs-17 --fs-20 --fs-24 --fs-28 --fs-34`

- Body copy is `--fs-14` or `--fs-15`. Metadata is `--fs-13`. Only uppercase Latin
  micro-labels may use `--fs-11` / `--fs-12`.
- **Chinese text is never negatively tracked.** `letter-spacing` stays `normal`
  except `--ls-caps` on uppercase Latin labels.
- Weight vocabulary: `400` body, `500` interactive/labels, `600` headings.
  Nothing is `700` or `800` except emergency emphasis.
- Line height: `--lh-tight` for titles, `--lh-normal` for body.

### Radius

`--r-2xs` (4) inline code & micro badges · `--r-xs` (8) chips, small buttons · `--r-sm` (12) buttons, inputs, rows ·
`--r-md` (16) cards, panels · `--r-lg` (24) app-level cards only · `--r-full` pills.

Icon glyphs are sized with `font-size` in px — that is icon geometry, not typography,
and is the only allowed raw px size.

### Elevation

`--sh-1` resting card · `--sh-2` popover / floating pill · `--sh-3` modal, menu.

Rules: a surface that sits directly on `--c-canvas` gets `--sh-1` and a
`1px solid var(--c-line)` border. A surface nested inside a card gets **no shadow** —
use `--c-surface-2` fill or a hairline border instead. Hover never lifts a card;
it changes border colour and background only.

### Space & motion

Spacing is `--sp-1` … `--sp-12` (4 px grid). Motion is
`var(--dur-fast) var(--ease-out)` for state, `--dur-slow` for layout.
Never animate `transform: translateY` on cards.

## 4. Layout

The app is one canvas with two floating cards:

```
┌───────────────────────────────────────────────┐
│ titlebar 44px: mark · current location ·  controls │
├─────────┬─────────────────────────┬───────────┤
│ sidebar │ content card (radius 24)│ assistant │
│ 228px   │  max-width 1040, centred│ 384px     │
└─────────┴─────────────────────────┴───────────┘
```

- The page title appears **once**, inside the content card. The titlebar is
  chrome, not a second heading.
- There is no app footer and no persistent status strip.
- The assistant column collapses to zero width; when collapsed it is a floating
  pill in the bottom-right corner.

## 5. Shared primitives — reuse, never redefine

```html
<!-- page header: exactly one per page -->
<header class="page-head">
  <div class="page-head-copy">
    <h1 class="page-title">…</h1>
    <p class="page-sub">…</p>
  </div>
  <div class="page-head-actions">…</div>
</header>

<!-- section heading inside a page -->
<div class="section-head">
  <div class="section-head-copy"><h2 class="section-title">…</h2></div>
  <div class="section-head-actions">…</div>
</div>

<!-- bordered surface -->
<section class="panel">
  <div class="panel-head"><div class="panel-head-copy"><h3 class="panel-title">…</h3></div>
    <div class="panel-actions">…</div></div>
  <div class="panel-body">…</div>
</section>

<!-- quiet inner group (no border, no shadow) -->
<div class="panel-subtle">…</div>

<!-- scannable list -->
<ul class="row-list">
  <li class="list-row is-interactive">
    <div class="list-row-main">
      <span class="list-row-title">…</span>
      <span class="list-row-detail">…</span>
      <span class="meta-line"><span class="meta-item">⏱ 12:04</span>…</span>
    </div>
    <div class="list-row-end">…</div>
  </li>
</ul>

<!-- segmented control -->
<div class="segmented" role="group">
  <button class="segmented-item" aria-pressed="true">…</button>
</div>

<!-- state -->
<span class="status-dot is-ready|is-live|is-pending|is-idle"></span>
<span class="soft-tag">…</span>
```

`src/styles.css` owns these. Page stylesheets must delete any duplicate definitions
they currently carry.

## 6. Component conventions

- **Primary action per screen: one.** It is `variant="contained"` (near-black).
  Everything else is `variant="outlined"` or `variant="text"`.
- **Empty states** are compact (`min-height` ≤ 200 px), left- or centre-aligned,
  and always offer the next action. Never a 250 px dashed box holding one sentence.
- **Capability / connection notices** are inline rows with a `status-dot`, not
  full-width alerts. Alerts are reserved for errors the user just caused.
- **Metadata** is `--fs-13` `--c-ink-3` with 15 px icons, separated by `.meta-line`.
- **Numbers that change** (timers, durations, counts) use
  `font-variant-numeric: tabular-nums`.
- **Icons** are one family only: the MUI `*Outlined` set. Never mix filled and
  outlined icons in the same row.
- **Never truncate an interactive label into an ellipsis** when the control has
  room to be restructured. Truncation is a last resort for user-generated content.

## 7. Definition of done for a page

1. No raw hex, no raw `font-size` px, no `border-radius` outside the token set.
2. No `!important` unless overriding a third-party inline style (justify in a comment).
3. Every class name used by the page's TSX is styled by that page's stylesheet or a
   shared primitive — no orphan selectors, no duplicate shared selectors.
4. Duplicate selectors previously defined in the page stylesheet for shared
   primitives are deleted.
5. `npx tsc -p tsconfig.app.json --noEmit` passes.
6. Verified visually at 1512×900 and 1280×800 in light mode; dark mode must not
   regress to unreadable contrast.
7. `src/i18n/strings.ts` is **not** edited. Reuse existing keys.
