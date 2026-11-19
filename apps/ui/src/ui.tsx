import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type SelectHTMLAttributes } from "react";
import { ChevronDown, X } from "lucide-react";
import { takeBack } from "./back.ts";

/** While a sheet is open, the Back button of the Android shell closes it before it goes back in the history. */
export function useBackClose(close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => takeBack(() => latest.current()), []);
}

/** A number that grows once a minute: what depends on the clock (which questions are due) lists it in its dependencies to be counted again. */
export function useMinute(): number {
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  return minute;
}

const WIDE = "(min-width: 960px)";
const watchWide = (notify: () => void) => {
  const query = matchMedia(WIDE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
/** Whether the window is wide enough for the side column of the bank page; narrower, that column is a sheet that slides in. */
export function useWide(): boolean {
  return useSyncExternalStore(watchWide, () => matchMedia(WIDE).matches);
}

/**
 * A panel that slides in from the right edge over the page, with its own head and a foot that stays at the bottom (`foot`).
 * Escape, the backdrop, the close button and Back all close it; `onClose` runs once, when it is closed.
 */
export function SideSheet({ title, closeLabel, foot, onClose, children }: { title: string; closeLabel: string; foot?: ReactNode; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useBackClose(() => dialog.current?.close());
  // No cleanup, as in `Peek`: removing the element closes it, and a close() here would fire a late "close" event.
  useEffect(() => {
    const el = dialog.current!;
    if (!el.open) el.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="side" aria-labelledby={id} onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current.close()}>
      <header className="side-head">
        <h2 id={id}>{title}</h2>
        <button type="button" className="button quiet icon close" onClick={() => dialog.current!.close()} aria-label={closeLabel}><X size={18} strokeWidth={1.5} aria-hidden /></button>
      </header>
      <div className="side-body">{children}</div>
      {foot && <footer className="side-foot">{foot}</footer>}
    </dialog>
  );
}

/**
 * For the bottom bar (`.dock`): hand the returned function to its `ref`. The page then knows the bar's height as `--dock`
 * (it grows when the buttons wrap), so focus and scrolling stop short of it instead of ending under it.
 * It also knows how much of the window the on-screen keyboard covers as `--keyboard`: a WebView that does not shrink the page
 * for the keyboard would leave the bar behind it, so the bar is lifted by that much.
 */
export function useDockHeight(): (el: HTMLElement | null) => void {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!bar) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--dock", `${bar.offsetHeight}px`);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(bar);

    const view = window.visualViewport;
    let up = false;
    let liftedAt = 0;
    let room = 0;
    let frame = 0;
    const setRoom = (px: number) => {
      room = px;
      root.style.setProperty("--keyboard-room", `${px}px`);
    };
    // The browser brings the focused field above the keyboard but not above the bar lifted onto it, so the page is scrolled the rest.
    // `scrollIntoView` would pan the visual viewport instead, and the header would slide under the status bar past its cover (`body::before`).
    // A scroll of the page itself may need room under the page (`--keyboard-room`, styles.css): only as much as it needs, since more would
    // show as a blank band under the bar at the end of the page. A field in a dialog is not under the bar, and one in the bank's side panel
    // (sticky, with a scroll of its own) does not move with the page, so a page scroll would only run on without reaching it.
    const lift = () => {
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !field.matches("input:not([type=checkbox], [type=radio]), textarea") || field.closest("dialog, .panel")) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.activeElement !== field) return;
        const hidden = Math.ceil(field.getBoundingClientRect().bottom + 16 - bar.getBoundingClientRect().top);
        if (hidden <= 0) return;
        const end = document.documentElement.scrollHeight - room - window.innerHeight;
        setRoom(Math.max(room, scrollY + hidden - end));
        scrollBy(0, hidden);
      });
    };
    const cover = () => {
      // A pinch zoom also shrinks the visual viewport; that is not a keyboard. Whether the keyboard is up is told by the height alone,
      // since dragging the page also moves the visible part (`offsetTop`); the lift follows that move, so the bar stays on the keyboard.
      const open = view != null && view.scale < 1.01 && window.innerHeight - view.height > 80;
      const keys = open ? Math.round(window.innerHeight - view.height) : 0;
      root.style.setProperty("--keyboard", `${open ? Math.max(0, keys - Math.round(view.offsetTop)) : 0}px`);
      // Lift when the keyboard comes up, and again when it has grown since the last lift (a row of suggestions, another layout), since the bar rises with it.
      if (open && (!up || keys > liftedAt + 8)) {
        lift();
        liftedAt = keys;
      } else if (open) {
        // A keyboard that shrank (a number pad on the next question) and grows back has to lift again.
        liftedAt = Math.min(liftedAt, keys);
      }
      if (!open) liftedAt = 0;
      if (!open && room) setRoom(0);
      up = open;
    };
    // Moving to another field with the keyboard already up (the keyboard's Next key, the next exam question) needs the same correction.
    const moved = () => { if (up) lift(); };
    cover();
    view?.addEventListener("resize", cover);
    view?.addEventListener("scroll", cover);
    document.addEventListener("focusin", moved);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      view?.removeEventListener("resize", cover);
      view?.removeEventListener("scroll", cover);
      document.removeEventListener("focusin", moved);
      root.style.removeProperty("--dock");
      root.style.removeProperty("--keyboard");
      root.style.removeProperty("--keyboard-room");
    };
  }, [bar]);
  return setBar;
}

/**
 * A question in a dialog of the page's own, in place of the browser's `confirm()`, which ignores the theme and is not shown by every WebView.
 * `stay` is the safe answer: it is focused first, and Escape means it. `danger` marks `go` as a step that cannot be undone.
 */
export function Confirm({ title, body, stay, go, danger, onStay, onGo }: { title: string; body: string; stay: string; go: string; danger?: boolean; onStay(): void; onGo(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    if (!dialog.current!.open) dialog.current!.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="confirm" aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onStay(); }}>
      <h2 id={id}>{title}</h2>
      <p>{body}</p>
      <div className="actions">
        <button type="button" className="button primary" autoFocus onClick={onStay}>{stay}</button>
        <button type="button" className={danger ? "button danger" : "button"} onClick={onGo}>{go}</button>
      </div>
    </dialog>
  );
}

/** A native select in a pill, with the chevron drawn from the icon set. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={className ? `select ${className}` : "select"}>
      <select {...props} />
      <ChevronDown size={18} strokeWidth={1.5} aria-hidden />
    </span>
  );
}

export interface SegmentOption<T extends string> { value: T; title: string; hint?: string; disabled?: boolean; icon?: ReactNode }

/** A row of mutually exclusive choices, drawn as one pill with the chosen one raised. */
export function Segmented<T extends string>({ label, value, options, onChange, wrap }: { label: string; value: T; options: SegmentOption<T>[]; onChange(v: T): void; wrap?: boolean }) {
  const group = useId();
  return (
    <fieldset className="field">
      <legend>{label}</legend>
      <div className={wrap ? "segmented wrap" : "segmented"}>
        {options.map((o) => (
          <label key={o.value} className={o.disabled ? "disabled" : undefined}>
            <input type="radio" name={group} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
            <span>{o.icon}<span>{o.title}</span>{o.hint && <small>{o.hint}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
