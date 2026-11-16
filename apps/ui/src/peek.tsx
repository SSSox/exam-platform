import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Memory, Status } from "@exam/core";
import type { Question } from "@exam/schema";
import { useApp } from "./app.tsx";
import { Rich } from "./rich.tsx";
import { Reference, useRightAnswer } from "./session.tsx";
import { StatusMark } from "./status.tsx";
import { useBackClose } from "./ui.tsx";

interface PeekProps {
  q: Question;
  language: string;
  topic: string;
  status: Status;
  due: boolean;
  memory?: Memory;
  tries: { count: number; right: number };
  bookmarked: boolean;
  /** Position among the questions the arrows walk through. */
  place: { at: number; of: number };
  onClose(): void;
  onStep(delta: -1 | 1): void;
  onAnswer(): void;
  onBookmark(): void;
}

/** Hours until a question is due, or whole days once it is more than a day and a half away. */
function wait(ms: number): { key: "peek.dueHours" | "peek.dueDays"; count: number } {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours < 36 ? { key: "peek.dueHours", count: hours } : { key: "peek.dueDays", count: Math.round(hours / 24) };
}

/** One question opened from the map: its state, how it went so far, and ways to work with it. */
export function Peek({ q, language, topic, status, due, memory, tries, bookmarked, place, onClose, onStep, onAnswer, onBookmark }: PeekProps) {
  const { t } = useTranslation();
  const { text } = useApp();
  const rightAnswer = useRightAnswer();
  const dialog = useRef<HTMLDialogElement>(null);
  useBackClose(() => dialog.current?.close());
  // The answer is shown for one question only, so stepping to the next one hides it with no flash of the new answer.
  const [shownFor, setShownFor] = useState<number>();
  const shown = shownFor === q.id;

  // No cleanup: removing the element from the page closes it, and a close() here would fire a late "close" event that dismisses the next open.
  useEffect(() => {
    const el = dialog.current!;
    if (!el.open) el.showModal();
  }, []);

  // On the document, not the dialog: when a step button disables itself at the end of the list, focus leaves it and the dialog stops getting keys.
  useEffect(() => {
    const keys = (e: globalThis.KeyboardEvent) => {
      if (e.key === "ArrowLeft" && place.at > 0) onStep(-1);
      if (e.key === "ArrowRight" && place.at < place.of - 1) onStep(1);
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [place.at, place.of, onStep]);
  const next = memory && !due ? ((w) => t(w.key, { count: w.count }))(wait(memory.due - Date.now())) : undefined;

  return (
    <dialog ref={dialog} className="peek" aria-label={`№ ${q.id}`} onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current.close()}>
      <div className="peek-body">
        <header className="peek-head">
          <span className="ticket">№ {String(q.id).padStart(3, "0")}</span>
          <span className="chip"><StatusMark status={status} />{t(`bank.legend.${status}`)}</span>
          {due && <span className="chip due"><StatusMark status={status} due />{t("peek.dueNow")}</span>}
          <button className="button quiet icon close" onClick={() => dialog.current!.close()} aria-label={t("peek.close")}><X size={18} strokeWidth={1.5} aria-hidden /></button>
        </header>
        <p className="meta">{t("peek.topic")}: {topic}{q.difficulty_level != null && ` · ${t("bank.level")} ${q.difficulty_level}`}</p>
        <div className="prompt" lang={language}><Rich text={text(q.question, language)} /></div>
        <p className="meta">{tries.count ? t("peek.tries", { count: tries.count, right: tries.right }) : t("peek.never")}{next && ` · ${next}`}</p>
        {shown && (
          <div className="peek-answer">
            <Reference q={q} language={language} lines={rightAnswer(q, language)} />
            {q.explanation && <Rich text={text(q.explanation, language)} />}
          </div>
        )}
        {/* The buttons stay at the bottom edge of the dialog, which on a phone is the bottom edge of the screen. */}
        <footer className="peek-foot">
          <div className="actions">
            <button className="button primary" onClick={onAnswer} autoFocus>{t("peek.answer")}</button>
            <button className="button" aria-expanded={shown} onClick={() => setShownFor(shown ? undefined : q.id)}>{shown ? t("peek.hide") : t("peek.show")}</button>
            <button className="button quiet icon" aria-pressed={bookmarked} onClick={onBookmark}>
              <Bookmark size={18} strokeWidth={1.5} fill={bookmarked ? "currentColor" : "none"} aria-hidden />{bookmarked ? t("session.bookmarked") : t("session.bookmark")}
            </button>
          </div>
          <div className="peek-nav">
            <button className="button quiet icon" disabled={place.at === 0} onClick={() => onStep(-1)} aria-label={t("peek.prev")}><ChevronLeft size={18} strokeWidth={1.5} aria-hidden /></button>
            <span className="meta">{place.at + 1} {t("session.of")} {place.of}</span>
            <button className="button quiet icon" disabled={place.at === place.of - 1} onClick={() => onStep(1)} aria-label={t("peek.next")}><ChevronRight size={18} strokeWidth={1.5} aria-hidden /></button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
