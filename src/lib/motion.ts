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

/** COVERED exit for content swaps (tab/stage): the entering view fades
 * IN over this one first (FADE_SWAP, 150 ms); only after it is covered
 * does this one fade out beneath it (delay 120 ms + 140 ms). The old
 * content never shows through the new one, there is no blank frame at
 * any point in the swap, and the unmount lands at ~260 ms. Used with
 * the CSS :not(:last-child) absolute lift in shell.css/explore.css. */
export const EXIT_COVERED: Transition = { duration: 0.14, ease: "easeIn", delay: 0.12 };
