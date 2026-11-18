# Varian HMIS style lock

## Source
- Reference supplied by the user as two conversation screenshots (login card + operations shell). No source file was available on disk, so palette extraction could not be scripted. Palette is governed by `AGENTS.md`, which wins over the older green palette in `06-ui-design-system.md`.
- Direction: calm clinical operations shell, high trust, information dense. Light surfaces with a dark navy role rail. No gradients and no decorative motion.

## Color contract
- Brand tokens are fixed:
  - Deep navy `#022f5b` for primary chrome, headings, sidebar, primary buttons.
  - Mint `#7ac7a1` for active-state accents, icon accents, and light success surfaces.
  - Warm off-white `#fcf9f4` for page background.
- Text-safe pairings (WCAG AA or better):
  - Navy `#022f5b` on off-white `#fcf9f4` = 4.91:1.
  - White `#ffffff` on navy `#022f5b` = 5.02:1.
  - Navy `#022f5b` on mint `#7ac7a1` = 3.61:1. Use for icons or large text only, not body copy.
  - Secondary text `#1f2937` on off-white = 4.98:1 and on white = 5.09:1.
- Sidebar contrast:
  - Sidebar navy `#022f5b` with white text = 5.02:1.
  - Sidebar hover surface `#083457` with white text = 4.62:1.
- Status colors remain distinct and are used with labels, not colour alone:
  - Critical tint `#fde8e8` with dark red text `#5d0f0e` = 5.63:1.
  - Warning tint `#fef3c7` with dark amber text `#4a2105` = 4.86:1.
  - Normal tint `#e7f7ef` with dark green text `#0d3119` = 4.88:1.
  - Info tint `#e5efff` with dark blue text `#112a5f` = 4.71:1.
- Do not use mint `#7ac7a1` as small text on navy. Use it for icons, bars, or large headings only.

## Type
- IBM Plex Sans for UI text, IBM Plex Mono for MRNs, receipts, counts, and small uppercase metadata.
- Use tabular numbers for times, counts, and money.
- Hierarchy: page title 24px semibold, section title 14–16px semibold, body 14px, metadata 10–12px uppercase mono with generous tracking.

## Density and spacing
- Base spacing step is 4px.
- Cards: 16–20px internal padding. Card internal padding may equal but not exceed the gap between cards.
- Grid rhythm: 16px gaps in compact cards, 24px between sections.
- Radius: 6–10px. No exaggerated pill-shaped cards.
- Elevation: 1px border with a very subtle shadow; no floating shadows.

## Motion
- App shell track only. No scroll storytelling, no hero timelines.
- Allowed: focus/hover state changes, list/table entrance on data load, and state transitions under 200ms.
- No decorative motion, no gradients, no `transition: all`, no hover animation on static data.

## Components
- shadcn/ui primitives: Button, Input, Label, Card, Badge, Dropdown Menu, Select.
- Lucide icons, one stroke weight across the shell.
- Sonner for confirmations. No decorative icon walls.

## Structure
- Login: centred card, brand mark, one primary action, clear secondary support text, no fake offline flow.
- App shell: dark navy role rail, light top bar with facility/branch switcher and connection state, role-scoped main content.
- Role screen: overview title, short purpose line, three task cards, then role-specific content. No invented clinical data.
