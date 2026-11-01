# scantor brand

The scanline S is the first letter of **scantor**, followed by **cantor**: the wordmark has no additional S.
Colors are in [`brand-tokens.json`](brand-tokens.json).

| Folder | Contents |
|---|---|
| `logos/` | the horizontal wordmark as SVG and transparent PNG: `light` for light backgrounds (dark letters), `dark` for dark backgrounds (light letters, slightly brighter gradient), `black` and `white` monochrome. `scantor-wordmark-*` is the same artwork as `scantor-logo-*` |
| `marks/` | the standalone scanline S (gradient, solid colors, monochrome) and app icons |
| `favicons/` | SVG favicon, multi-resolution ICO, PNG sizes from 16 to 256 px, Apple touch icon, Android and maskable icons, web manifest |
| `readme/` | spacious transparent README logos and solid-background banners, both themes |
| `previews/` | the approved design and an overview of both themes |

## Rules

- Use the wordmark wherever the name appears (README, web UI). Use the standalone S only where the wordmark
  does not fit: favicons, app icons, a collapsed sidebar.
- Never put the standalone S next to the wordmark: the wordmark already begins with it.
- Pick the variant by the background, not by preference: `light` on light surfaces, `dark` on dark ones.
- The SVGs are outlined paths without fonts, scripts or external references; PNGs are rendered from them.
  Edit the SVG and re-render the PNGs, never the other way round.

These files are used directly, not copied: the README header uses `readme/`, and the orchestrator serves
`favicons/` at the dashboard root and bundles the wordmark and mark from `logos/` and `marks/`.
