# DiskBytes

**A Windows disk-space analyzer that shows you where every byte lives — and only ever cleans up through the Recycle Bin.**

Rust core + Tauri 2 (WebView2) + React/TypeScript Canvas UI. No Electron, no browser bloat, no telemetry you can't switch off.

## What it does

- **Explore** a drive or folder with 9 visualizations (treemap, sunburst, flame, bubbles, mind-map, Folders grid, Top Sizes, Age Map, List), an inspector for every item, and instant name filtering.
- **Turbo engine** (NTFS MFT direct parse, elevated): seconds-class scans of `C:\`; the standard engine is always the honest fallback — user-visible, with a reason.
- **Duplicates**: 3-pass SHA-256 grouping with hardlink exclusion and "keep this, stage the rest".
- **Applications**: registry + MSIX uninstaller with bundle sizes, last-used, leftover matching, and a safe uninstall flow (close → the app's own uninstaller → stage leftovers).
- **Monitor**: live CPU / memory / network / storage + top processes, sampled every 2 seconds with Win32/NT APIs (no shelling out).
- **Snapshots**: take / diff folder footprints over time.
- **Cleanup Queue**: stage from anywhere, confirm once, and everything moves to the **Recycle Bin** — DiskBytes never deletes directly and never touches protected or cloud files.

## Safety model

1. Zero direct-delete APIs in the product code (enforced by a grep in CI).
2. Recycle Bin only, with pre-flight refusal for items that can't be recycled (non-fixed drives, disabled bin, oversized).
3. Cloud placeholders are never opened, previewed, or hashed.
4. The only fallback in the product is Turbo → standard, always with a stated reason.

## Build (Windows)

```powershell
npm install
npm run tauri dev          # dev window
scripts/build.ps1          # release: NSIS + portable zip + SHA256SUMS.txt
```

Full gate battery (fmt, clippy `-D warnings`, tests, typecheck, vitest, safety greps) runs in CI on every push — `windows-latest`, the same environment that builds the installer.

## Licensing

Free to scan and analyze everything. **Pro** (Dodo Payments) unlocks unlimited cleanup — the free plan moves up to 1 GB per queue. Offline grace is 14 days; after that cleanup becomes read-only until you reconnect (scanning never stops).

## Privacy

Analytics (PostHog) is anonymous by default, off when unconfigured, and one checkbox to disable entirely. No file names, no paths, no screenshots — ever. See `docs/DISTRIBUTION.md` and the in-app License panel.

© 2026 DiskBytes

## UI/UX system (v2 — production polish pass)

The frontend speaks one design system, defined in `src/theme/tokens.css`:

- **Loading v2** — one language for every wait: the dual-arc spinner (indeterminate mark), **skeleton structure previews** (list/table loads keep their header + row rhythm — no collapse-to-void, no reflow when data lands), and the radial scan visual (hero). All loops sit on one harmonic tempo; `prefers-reduced-motion` gets a documented essential-motion hierarchy instead of freezing mid-gesture.
- **Motion** — CSS tokens (`--dur-*`, `--ease-*`) + framer presets (`src/lib/motion.ts`: `SPRING_UI/POP/TOAST/FADE_SWAP`); `MotionConfig reducedMotion="user"` at the root.
- **Canvas** — treemap folder **title bands** (engine `HEADER` cells) render folder names + sizes; keyboard navigation on all 5 canvas modes; selection/hover rings fade in (120 ms rAF); single-paint with preloaded names (no label pop-in); DPR-migration tracking.
- **Buttons** — `.db-ink-button/.db-outline` + `.auto/.danger/.compact` variants; no inline size patches.
- **A11y** — menus share one keyboard model (`useMenuBehavior`), `role="menuitem"`, focus rings via `--focus-w/--focus-offset` tokens, modal-guarded hotkeys.

### Why no shadcn / DaisyUI / HeroUI / Radix Themes

DiskBytes' UI is a hand-crafted canvas application (9 viz modes drawn in `<canvas>`) on top of a custom token system tuned per-viewer (VLM) audits. DaisyUI, HeroUI and shadcn/MagicUI are Tailwind-based component systems; installing three of them alongside the existing 4,000-line custom CSS layer would double the CSS payload and put two competing theming systems in conflict — while their value (form controls, marketing-page components) barely intersects this app's surface (charts, trees, tables). The polish pass instead ports what those libraries stand FOR: tokenized spacing/type/motion scales, variant-based components, accessible overlays, and animation choreography — into the existing system. `framer-motion` (already a dependency) covers the animation layer those libraries would have provided.
