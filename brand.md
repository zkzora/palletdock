# Brand — PalletDock

_Status: active — extracted from the supplied PalletDock landing and dashboard exports_

## Direction

PalletDock is a compact, technical developer workspace. It uses flat near-black surfaces, fine cool-gray borders, restrained status color, and dense but readable data layouts. The existing `PalletDock Landing.dc.html` and `PalletDock App v2.dc.html` exports remain the visual source of truth.

## Typography

- UI and editorial: Instrument Sans, weights 400–700.
- Code, hashes, quantities, labels: JetBrains Mono, weights 400–600.
- Page headings use tight tracking and restrained scale; dashboard headings are 26–28px rather than oversized marketing type.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| Background | `#0e0f11` | Application canvas |
| Sidebar | `#111214` | Navigation and code surfaces |
| Surface | `#16181b` | Cards and tables |
| Elevated | `#1b1d21` | Hover/secondary controls |
| Border | `#25282d` | Primary separators |
| Border strong | `#34373d` | Inputs and interactive outlines |
| Foreground | `#ecedee` | Primary text |
| Muted | `#b5b9c0` | Body/supporting text |
| Dim | `#8a8f98` | Metadata and mono labels |
| Success | `#4ccf8a` | Confirmed healthy/success states |
| Info | `#6cb2f5` | Progress and observed activity |
| Warning | `#f0b429` | Stale/needs-attention states |
| Danger | `#f2685a` | Errors and destructive states |

## Shape and interaction

- Buttons and inputs: 7–8px radius; cards: 10–14px radius.
- Separation is primarily one-pixel borders, not shadows.
- Focus uses a 2px light ring with 2px offset.
- Dashboard controls remain compact on desktop but preserve a minimum 40px touch target on narrow screens.
- Status color is always paired with text; color alone never communicates state.

## Voice

Direct, precise, and evidence-aware. Say `Unavailable`, `Not checked`, or `Finality not confirmed` when a fact is unknown. Never imply deployment, verification, health, or finality without an observed record.
