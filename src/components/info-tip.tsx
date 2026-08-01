"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * A tooltip that works on touch devices.
 *
 * The native `title` attribute renders nothing on mobile: it fires on hover, and touch devices have no
 * hover state. Every `title`-based tip on this site is therefore invisible to phone users, which is most
 * of them. This replaces it with a tap/click-toggled popover.
 *
 * Deliberate choices:
 *  - Toggles on CLICK on every device rather than hover-on-desktop plus tap-on-mobile. One interaction
 *    model is predictable, and a hover/tap hybrid is where these usually break.
 *  - A real <button>, so it is keyboard-reachable and screen-reader-announced. `aria-describedby` links
 *    the popover to the trigger; Escape and outside-tap both dismiss.
 *  - `pointerdown` for the outside-dismiss listener, because `click` fires too late on iOS Safari and
 *    lets a tap-through reach whatever is underneath.
 *  - Width is capped against the VIEWPORT (max-w-[min(18rem,80vw)]) rather than the container, so it
 *    cannot push a narrow phone layout sideways.
 */
export function InfoTip({
  label,
  tip,
  className = "",
}: {
  label: React.ReactNode;
  tip: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        className="inline-flex items-center gap-1 text-left underline decoration-dotted underline-offset-2 hover:text-beacon"
      >
        {label}
        <span aria-hidden className="text-[10px] leading-none opacity-60">
          &#9432;
        </span>
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="surface absolute left-0 top-full z-30 mt-1.5 block w-max max-w-[min(18rem,80vw)] rounded-lg border p-2.5 text-xs font-normal leading-relaxed text-muted shadow-lg"
        >
          {tip}
        </span>
      )}
    </span>
  );
}
