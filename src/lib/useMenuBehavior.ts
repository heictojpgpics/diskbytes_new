/**
 * Shared context-menu behavior (design system v2): the native-menu
 * keyboard model + outside-close + first-item focus that
 * ItemContextMenu pioneered. QuickWins' custom menu re-implemented a
 * weaker version (no arrows/Home/End, click+blur outside-close that
 * survives drag-out) — one hook now serves every `role="menu"`.
 *
 * Contract: the caller owns a `ref` to the `.db-context` element; items
 * are `.db-ctx-item` buttons (disabled items are skipped).
 */
import { useEffect, type RefObject } from "react";

export function useMenuBehavior(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    // Capture-phase pointerdown: a drag that starts inside and ends
    // outside must still close (click-based close survives it).
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Native-menu keyboard model: ↑/↓ cycle items, Home/End jump,
    // Tab dismisses (menus don't tab-navigate), Esc closes. Items are
    // real buttons — Enter/Space activate the focused one natively.
    const items = () =>
      [...ref.current?.querySelectorAll<HTMLButtonElement>(".db-ctx-item:not([disabled])") ?? []];
    const focusItem = (dir: 1 | -1 | "first" | "last") => {
      const list = items();
      if (list.length === 0) return;
      const active = document.activeElement as HTMLButtonElement | null;
      const i = list.indexOf(active!);
      let next: HTMLButtonElement;
      if (dir === "first") next = list[0];
      else if (dir === "last") next = list[list.length - 1];
      else if (i < 0) next = dir === 1 ? list[0] : list[list.length - 1];
      else next = list[(i + dir + list.length) % list.length];
      next.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusItem(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusItem(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusItem("first");
      } else if (e.key === "End") {
        e.preventDefault();
        focusItem("last");
      }
    };
    // Alt-Tab / focus-loss closes the menu (native menu behavior;
    // the QuickWins predecessor also closed on blur).
    const onBlur = () => onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    // Enter the menu focused (screen readers announce the item, not
    // the page behind it).
    requestAnimationFrame(() => items()[0]?.focus());
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [ref, open, onClose]);
}
