# 06 — UI Design System

- **Tone:** calm, clinical, high-trust, information-dense. No gradients or decorative motion.
- **Palette (CSS variables, light + dark):** primary teal `#0F766E`, sidebar deep green `#0B3B36`, background `#F7FAF9`, surface white, text slate `#0F172A`, muted `#64748B`.
  Status: red `#DC2626` (emergency/critical), amber `#D97706` (priority/warning), green `#16A34A` (non-urgent/normal), blue `#2563EB` (info).
- **Type:** IBM Plex Sans for UI, IBM Plex Mono for MRNs/receipts; `font-variant-numeric: tabular-nums` on vitals, money, counts.
- **Layout:** left sidebar per role, top bar with facility/branch switcher, connection status pill (Online / Syncing / Offline), user menu. Pinned patient banner on clinical screens.
- **Components:** shadcn/ui (Button, Input, Select, Dialog, Sheet, Table, Tabs, Badge, Command for search), Sonner toasts, Lucide icons.
- **Queues:** table rows with triage colour bar on the left, wait-time counter, one primary action per row ("Call", "Start", "Collect", "Dispense", "Bill").
- **Forms:** react-hook-form + zod, inline errors, keyboard-first (Enter submits, Tab order logical), 16 px inputs on touch.
- **Motion:** none on keyboard actions and queue refresh; 150–200 ms ease-out for dialogs/sheets; respect `prefers-reduced-motion`.
- **Accessibility:** WCAG 2.1 AA contrast, visible focus rings, colour never the only signal (badge text + colour).
- **Print:** receipts (80 mm thermal), lab reports and drug labels via print CSS.
