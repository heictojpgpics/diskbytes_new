/**
 * Motion presets (design system v2) — the ONE source for every
 * framer-motion spring/duration in the app.
 *
 * Before this module five unrelated springs (480/38, 500/40, 520/34,
 * 500/26, 420/32) animated the same "element pops in" role and none
 * respected prefers-reduced-motion. These presets give each ROLE a
 * tuning, all members of one family:
 *
 *   spring.ui       — general UI elements (pills, badges, chips)
 *   spring.pop      — floating surfaces (popovers, anchored panels)
 *   spring.toast    — bottom toast (slightly softer, longer travel)
 *   fade.swap       — content/stage swaps (non-spring, eased)
 *
 * CSS-side motion tokens (--dur-*, --ease-*, see tokens.css) cover
 * stylesheet animations; the two systems share the same tempo ladder.
 */
import type { Transition } from "framer-motion";

/** Small UI elements: fast settle, no visible overshoot. */
export const SPRING_UI: Transition = { type: "spring", stiffness: 480, damping: 38 };

/** Floating surfaces entering from an anchor: slightly softer, tiny
 * overshoot reads as physical at popover scale. */
export const SPRING_POP: Transition = { type: "spring", stiffness: 480, damping: 34 };

/** Toast: softest member (longer travel distance needs it). */
export const SPRING_TOAST: Transition = { type: "spring", stiffness: 420, damping: 32 };

/** Stage/content swap: 150 ms easeOut — duration-based so it never
 * overshoots layout content. */
export const FADE_SWAP: Transition = { duration: 0.15, ease: "easeOut" };

/** Overlay exit: quick, no spring (springs on exit feel sticky). */
export const EXIT_FAST: Transition = { duration: 0.14, ease: "easeIn" };

/** VEIL swap (tab/stage, session-4): the entering view is a SOLID
 * sheet (`background: var(--background)` on the swap wrapper) that
 * fades in over the old one — the old content is progressively VEILED
 * by an opaque panel, never blended with the new content (the old
 * crossfade's double-exposure read as "page in page" ghosting, most
 * visible in dark mode). The old view stays fully opaque beneath and
 * unmounts covered. 120 ms in, plus a 5 px rise so the sheet settles
 * rather than pops — reads as a page laid down, not a re-render. */
export const SWAP_ENTER: Transition = { duration: 0.12, ease: "easeOut" };

/** The covered view's linger: opacity stays 1 the whole time (no
 * fade-out = no ghost); the duration only paces the unmount AFTER the
 * entering sheet is fully opaque (120 ms) plus a safety margin. */
export const SWAP_EXIT: Transition = { duration: 0.2, ease: "linear" };
