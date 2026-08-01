"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * A tooltip that works on touch devices and cannot escape the viewport.
 *
 * The native `title` attribute renders nothing on mobile: it fires on hover, and touch devices have no
 * hover state, so every `title`-based tip is invisible to phone users. This is a tap/click-toggled
 * popover instead.
 *
 * Positioning is FIXED and measured, not CSS-anchored. An `absolute left-0` popover overflows the screen
 * for any trigger in the right-hand half of the layout, which on a two-column mobile grid is half of
 * them. It also gets clipped by any ancestor with `overflow: hidden`. Measuring against the viewport and
 * positioning fixed solves both: the popover is clamped into the visible area horizontally, and flips
 * above the trigger when there is no room below.
 *
 * Other deliberate choices:
 *  - Toggles on CLICK on every device rather than hover-on-desktop plus tap-on-mobile. One interaction
 *    model is predictable; the hybrid is where these usually break.
 *  - A real <button>, so it is keyboard-reachable and announced. `aria-describedby` links the popover to
 *    its trigger, `aria-expanded` reflects state, Escape and outside-tap dismiss.
 *  - Outside-dismiss listens on `pointerdown`: on iOS Safari `click` fires late enough that the tap
 *    passes through to whatever sits underneath.
 *  - Scroll and resize close it, because a fixed-position element would otherwise detach from its
 *    trigger the moment the page moves.
 */
export function InfoTip({
  label,
  tip,
  className = "",
  triggerClassName,
}: {
  label: React.ReactNode;
  tip: string;
  className?: string;
  /** Replaces the default underline trigger styling. Badges pass their own pill classes: the pill is
   *  already the affordance, and a dotted underline inside a coloured chip reads as damage. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const id = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // Measure once the popover is in the DOM, then clamp it into the viewport.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const PAD = 8;
    const GAP = 6;
    const b = btn.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const maxW = Math.min(288, window.innerWidth - PAD * 2);

    let left = b.left;
    if (left + p.width > window.innerWidth - PAD) left = window.innerWidth - PAD - p.width;
    if (left < PAD) left = PAD;

    // Prefer below; flip above when the bottom of the screen is closer than the popover is tall.
    let top = b.bottom + GAP;
    if (top + p.height > window.innerHeight - PAD) {
      const above = b.top - p.height - GAP;
      if (above >= PAD) top = above;
      else top = Math.max(PAD, window.innerHeight - PAD - p.height);
    }
    setPos({ top, left, width: maxW });
  }, [open, tip]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // capture:true so it also fires for scrolls inside any scrollable ancestor
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <span className={`inline-block ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        className={
          triggerClassName
            ? `inline-flex items-center gap-1 ${triggerClassName}`
            : "inline-flex items-center gap-1 text-left underline decoration-dotted underline-offset-2 hover:text-beacon"
        }
      >
        {label}
        <span aria-hidden className="text-[10px] leading-none opacity-60">
          &#9432;
        </span>
      </button>
      {open && (
        <span
          ref={popRef}
          id={id}
          role="tooltip"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            maxWidth: pos?.width ?? 288,
            // Rendered invisibly for one frame so it can be measured before being placed; otherwise it
            // would flash at the wrong position on slower devices.
            visibility: pos ? "visible" : "hidden",
          }}
          className="surface fixed z-50 block w-max rounded-lg border p-2.5 text-xs font-normal leading-relaxed text-muted shadow-lg"
        >
          {tip}
        </span>
      )}
    </span>
  );
}
