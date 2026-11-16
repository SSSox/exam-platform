import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Bookmark, Check, X } from "lucide-react";
import {
  attemptEvent, bankTerms, finish, goTo, project, shuffled, submit, summarize, timeLeftSec, typedSlots, uuidv7,
  type Graded, type ProgressEvent, type Response, type Session, type SessionItem,
} from "@exam/core";
import type { Question } from "@exam/schema";
import { clearSavedExam, deviceId, loadSavedExam, saveExam } from "./platform.ts";
import { useApp } from "./app.tsx";
import { Rich } from "./rich.tsx";
import { Line } from "./line.tsx";
import { Confirm, useDockHeight } from "./ui.tsx";
import { STATIONS, shown, submitDrafts, unansweredCount, type Draft } from "./lib.ts";

const number = (id: number) => `№ ${String(id).padStart(3, "0")}`;
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export function useRightAnswer() {
  const { text } = useApp();
  return (q: Question, language: string): string[] => {
    switch (q.type) {
      case "single_choice":
      case "multiple_choice": return q.options.filter((o) => q.correct_answers.includes(o.id)).map((o) => text(o.text, language));
      case "short_text": return q.answers.map((a) => (a.accept[language] ?? Object.values(a.accept)[0]!)[0]!);
      case "numeric": return [`${q.answer.value}${q.answer.unit ? ` ${text(q.answer.unit, language)}` : ""}`];
      case "open": return [text(q.model_answer, language)];
    }
  };
}

function Verdict({ graded }: { graded: Graded }) {
  const { t } = useTranslation();
  const partly = !graded.correct && graded.score > 0;
  return (
    <p className={`verdict ${graded.correct ? "ok" : "bad"}`}>
      {graded.correct ? <Check size={18} strokeWidth={1.5} aria-hidden /> : <X size={18} strokeWidth={1.5} aria-hidden />}
      {graded.correct ? t("session.correct") : partly ? t("session.partly") : t("session.incorrect")}
    </p>
  );
}

/** The form of the open question; its Check button lives in the dock at the bottom of the screen and points here. */
const ANSWER_FORM = "answer";

/** `dock` is the place in the bottom bar where the question's own buttons (Check, Show the answer, Knew it) go. */
function Answer({ q, item, language, locked, exam, dock, draft, onDraft, onSubmit }: { q: Question; item: SessionItem; language: string; locked: boolean; exam: boolean; dock: HTMLElement | null; draft: Draft; onDraft(patch: Draft): void; onSubmit(r: Response): void }) {
  const { t } = useTranslation();
  const { text } = useApp();
  const rightAnswer = useRightAnswer();
  const inDock = (buttons: ReactNode) => dock && createPortal(buttons, dock);
  const previous = item.response;
  const selected = draft.selected ?? (previous?.mode === "choice" ? previous.selected : []);
  const texts = draft.texts ?? (previous?.mode === "typed" ? previous.texts : Array(Math.max(1, typedSlots(q))).fill(""));
  const setSelected = (change: (old: string[]) => string[]) => onDraft({ selected: change(selected) });
  const setTexts = (change: (old: string[]) => string[]) => onDraft({ texts: change(texts) });
  const [revealed, setRevealed] = useState(previous?.mode === "self_check");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  if (item.mode === "choice" && (q.type === "single_choice" || q.type === "multiple_choice")) {
    const single = q.type === "single_choice";
    const pickOption = (id: string) => setSelected((old) => (single ? [id] : old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
    const send = (e: FormEvent) => { e.preventDefault(); if (!locked && selected.length) onSubmit({ mode: "choice", selected }); };
    return (
      <>
      <form id={ANSWER_FORM} onSubmit={send}>
        <p className="hint">{t(single ? "session.one" : "session.many")}</p>
        <ul className="options">
          {shuffled(q.options, q.id + (item.again ?? 0) * 997).map((o) => {
            const state = !locked ? "" : q.correct_answers.includes(o.id) ? "right" : selected.includes(o.id) ? "wrong" : "";
            return (
              <li key={o.id}>
                <label className={`option ${state}`}>
                  <input type={single ? "radio" : "checkbox"} name="option" checked={selected.includes(o.id)} disabled={locked} onChange={() => pickOption(o.id)} />
                  <Rich text={text(o.text, language)} inline />
                  {/* Colour alone must not say which option was right: a mark and a word do too. */}
                  {state && (
                    <span className="verdict-mark">
                      {state === "right" ? <Check size={18} strokeWidth={1.5} aria-hidden /> : <X size={18} strokeWidth={1.5} aria-hidden />}
                      <span className="visually-hidden">{t(state === "right" ? "session.correct" : "session.incorrect")}</span>
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </form>
      {!locked && inDock(<button className="button primary" form={ANSWER_FORM} disabled={!selected.length}>{t(exam ? "session.send" : "session.check")}</button>)}
      </>
    );
  }

  if (item.mode === "typed") {
    const numeric = q.type === "numeric";
    // Enter in a read-only field still submits a form that has a single field: a checked answer must not be graded and logged twice.
    const send = (e: FormEvent) => { e.preventDefault(); if (!locked && texts.some((x) => x.trim())) onSubmit({ mode: "typed", texts }); };
    const parts = item.graded?.parts;
    return (
      <>
      <form id={ANSWER_FORM} onSubmit={send}>
        <p className="hint">{texts.length > 1 ? t("session.typeMany", { count: texts.length }) : t("session.typeOne")}</p>
        <div className="inputs">
          {texts.map((value, i) => (
            <input
              key={i} ref={i === 0 ? first : undefined} className={locked && parts ? (parts[i]?.ok ? "right" : "wrong") : ""}
              type="text" inputMode={numeric ? "decimal" : "text"} autoComplete="off" autoCapitalize="off" spellCheck={false} lang={language}
              aria-label={`${numeric ? t("session.number") : t("session.answer")} ${texts.length > 1 ? i + 1 : ""}`} placeholder={numeric ? t("session.number") : t("session.answer")}
              value={value} readOnly={locked} onChange={(e) => setTexts((old) => old.with(i, e.target.value))}
            />
          ))}
        </div>
      </form>
      {!locked && inDock(<button className="button primary" form={ANSWER_FORM} disabled={!texts.some((x) => x.trim())}>{t(exam ? "session.send" : "session.check")}</button>)}
      </>
    );
  }

  return (
    <div>
      <p className="hint">{t("session.recall")}</p>
      {!revealed ? (
        !locked && inDock(<button type="button" className="button primary" onClick={() => setRevealed(true)}>{t("session.reveal")}</button>)
      ) : (
        <>
          <Reference q={q} language={language} lines={rightAnswer(q, language)} />
          {!locked && inDock(
            <>
              <button type="button" className="button" onClick={() => onSubmit({ mode: "self_check", knew: false })}>{t("session.didNot")}</button>
              <button type="button" className="button primary" onClick={() => onSubmit({ mode: "self_check", knew: true })}>{t("session.knew")}</button>
            </>,
          )}
        </>
      )}
    </div>
  );
}

export function Reference({ q, language, lines }: { q: Question; language: string; lines: string[] }) {
  const { t } = useTranslation();
  const { text } = useApp();
  return (
    <div className="reference">
      <p className="label">{q.type === "open" ? t("session.model") : t("session.right")}</p>
      {lines.map((line) => <Rich key={line} text={line} />)}
      {q.type === "open" && q.rubric && (
        <>
          <p className="label">{t("session.rubric")}</p>
          <ul>{q.rubric.map((r, i) => <li key={i}>{text(r.criterion, language)} <span className="meta">{r.points}</span></li>)}</ul>
        </>
      )}
    </div>
  );
}

function Feedback({ q, item, language, bank, attempt }: { q: Question; item: SessionItem; language: string; bank: string; attempt?: string }) {
  const { t } = useTranslation();
  const { text, events, append } = useApp();
  const rightAnswer = useRightAnswer();
  const graded = item.graded!;
  const disputed = events.some((e) => e.type === "dispute" && e.attempt === attempt);
  const spelling = graded.correct && (graded.matchKind === "typo" || graded.matchKind === "layout") ? graded.parts?.map((p) => p.matched).filter(Boolean).join(", ") : undefined;
  const source = q.source_references?.map((r) => [r.file, r.location].filter(Boolean).join(", ")).filter(Boolean).join("; ");
  const dispute = () => attempt && append([{ id: uuidv7(Date.now()), type: "dispute", at: Date.now(), device: deviceId, bank, question: q.id, attempt }]);
  // The button that sent the answer is gone by now, so focus goes to the verdict: it is read out and scrolled into view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div className="feedback" ref={box} tabIndex={-1}>
      <Verdict graded={graded} />
      {spelling && <p className="hint">{t("session.accepted")}: {spelling}</p>}
      {item.mode !== "self_check" && !graded.correct && <Reference q={q} language={language} lines={rightAnswer(q, language)} />}
      {q.explanation && <Rich text={text(q.explanation, language)} />}
      {source && <p className="meta">{t("session.source")}: {source}</p>}
      {item.mode === "typed" && !graded.correct && attempt && (
        disputed ? <p className="hint">{t("session.disputed")}</p> : <button className="button quiet" onClick={dispute}>{t("session.dispute")}</button>
      )}
    </div>
  );
}

export function SessionScreen() {
  const { t } = useTranslation();
  const { running, run, text, fellBack, events, append, commit, settings } = useApp();
  const { session, bundle, back, hash, line } = running!;
  const language = bundle.bank.language;
  const questions = useMemo(() => new Map(bundle.questions.map((q) => [q.id, q])), [bundle]);
  const options = useMemo(() => ({ scoring: bundle.bank.scoring.multiple_choice, bankTerms: bankTerms(bundle.questions) }), [bundle]);
  const [attempts, setAttempts] = useState<Record<number, string>>({});
  const [drafts, setDrafts] = useState<Record<number, Draft>>(running!.drafts ?? {});
  const [asking, setAsking] = useState(false);
  const [allShown, setAllShown] = useState(false);
  /** Where the open question puts its own buttons in the bottom bar. */
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const dockBar = useDockHeight();
  const [now, setNow] = useState(Date.now());
  const states = useMemo(() => project(events, session.bank), [events, session.bank]);
  const rightAnswer = useRightAnswer();
  const exam = session.config.kind === "exam";
  const done = session.finishedAt != null;
  const locale = settings.content === "auto" ? settings.ui : settings.content;
  const set = (next: Session) => run({ ...running!, session: next });

  const eventsOf = (s: Session, indexes: number[]) => {
    const at = Date.now();
    return indexes.map((i) => attemptEvent(s, s.items[i]!, questions.get(s.items[i]!.question)!, at, deviceId, locale));
  };
  const log = (added: ProgressEvent[], indexes: number[]) => {
    setAttempts((old) => ({ ...old, ...Object.fromEntries(added.map((e, n) => [indexes[n]!, e.id])) }));
    return commit(added);
  };
  const record = (s: Session, indexes: number[]) => log(eventsOf(s, indexes), indexes);

  const ending = useRef(false);
  /** The exam is kept in local storage from its first shown question to its end, so a reload, a closed window or a restarted app does not lose it. */
  useEffect(() => {
    if (exam && !done && !ending.current) saveExam({ v: 1, session, drafts, back, line, hash });
  }, [exam, done, session, drafts, back, line, hash]);
  // Walking away from an exam with no answers yet is not held (see holdExam), so it is not kept either: the next launch must not open it again.
  // Only that one: an exam with answers leaves the screen unfinished when the page crashes, and a reload has to bring it back.
  // A reload or a closed app runs no cleanup.
  const kept = useRef(false);
  kept.current = exam && !done && !session.items.some((item) => item.graded);
  useEffect(() => () => {
    if (kept.current) clearSavedExam();
  }, []);

  /**
   * Ends the session. An exam first takes the answers still unsent as its answers, then writes them all to the log. Until the log has them
   * they wait in the kept copy as events (`pending`): a failed write or an app closed at this moment loses nothing, and the next launch
   * writes the same events, not a second set.
   */
  const end = (s: Session) => {
    if (ending.current) return;
    ending.current = true;
    const finished = finish(exam ? submitDrafts(s, drafts, questions, options, Date.now()) : s, Date.now());
    if (exam) {
      const indexes = finished.items.flatMap((item, i) => (item.graded ? [i] : []));
      const pending = eventsOf(finished, indexes);
      saveExam({ v: 1, session: s, drafts, back, line, hash, pending });
      // Only its own copy: by the time the log answers, another exam may have been started and kept.
      void log(pending, indexes).then((stored) => stored && loadSavedExam()?.session.id === s.id && clearSavedExam());
    }
    set(finished);
  };
  const latestEnd = useRef(end);
  latestEnd.current = end;

  // The clock ticks on its own, whatever the screen re-renders: typing must not hold it back.
  const left = timeLeftSec(session, now);
  const timed = !done && session.config.timeLimitSec != null;
  useEffect(() => {
    if (!timed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed]);
  useEffect(() => {
    if (timed && left === 0) latestEnd.current(session);
  }, [timed, left]);

  const leave = () => { run(undefined); location.hash = back; };

  // The row of question numbers scrolls sideways on a phone: keep the open question in view.
  const palette = useRef<HTMLElement>(null);
  useEffect(() => {
    palette.current?.querySelector(".current")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [session.index]);

  if (done) {
    const summary = summarize(session);
    const seen = shown(session);
    const firsts = seen.filter((i) => !i.again);
    const wrong = firsts.filter((i) => i.graded && !i.graded.correct).map((i) => i.question);
    const repeats = seen.length - firsts.length;
    // A long exam is mostly right answers: the review opens on what needs another look, and the rest is one tap away.
    const missed = firsts.filter((i) => !i.graded?.correct);
    const listed = allShown ? firsts : missed;
    return (
      <div className="sheet" data-l={running!.line ?? 0}>
        <h1>{t("result.title")}</h1>
        <div className="card score">
          <span className="score-number">{summary.percent}<small>%</small></span>
          <span className="score-text">
            {t("result.score", { correct: summary.correct, total: exam ? summary.total : summary.answered })}
            {summary.passed != null && <span className={`verdict ${summary.passed ? "ok" : "bad"}`}>{summary.passed ? t("result.passed") : t("result.failed")}</span>}
          </span>
          <Line count={STATIONS} lit={Math.round((STATIONS * summary.percent) / 100)} />
        </div>
        {firsts.length > 0 && (
          <>
            <div className="review-head">
              <h2>{t("result.review")}</h2>
              {missed.length < firsts.length && (
                <button className="button quiet" aria-expanded={allShown} onClick={() => setAllShown(!allShown)}>
                  {allShown ? t("result.onlyMissed") : t("result.showAll", { count: firsts.length })}
                </button>
              )}
            </div>
            {listed.length === 0 && <p className="meta">{t("result.allRight")}</p>}
            <ol className="review">
              {listed.map((item) => {
                const q = questions.get(item.question)!;
                return (
                  <li key={q.id} className={!item.graded ? "none" : item.graded.correct ? "ok" : "bad"}>
                    <span className="ticket">{number(q.id)}</span>
                    <div>
                      <Rich text={text(q.question, language)} />
                      <p className="meta">{item.graded ? `${t("session.right")}: ${rightAnswer(q, language).join("; ")}` : t("result.unanswered")}</p>
                    </div>
                    {item.graded?.correct ? <Check size={18} strokeWidth={1.5} role="img" aria-label={t("session.correct")} /> : <X size={18} strokeWidth={1.5} role="img" aria-label={item.graded ? t("session.incorrect") : t("result.unanswered")} />}
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {wrong.length > 0 && <p className="meta">{t("bank.mistakes")}: {wrong.length}</p>}
        {repeats > 0 && <p className="meta">{t("result.repeated", { count: repeats })}</p>}
        <footer className="dock" ref={dockBar}>
          <button className="button primary" onClick={leave}>{t("result.toBank")}</button>
        </footer>
      </div>
    );
  }

  const item = session.items[session.index]!;
  const q = questions.get(item.question)!;
  const prompt = item.mode !== "choice" && "free_input" in q && q.free_input?.question ? q.free_input.question : q.question;
  const last = session.index === session.items.length - 1;
  const locked = !exam && item.graded != null;
  const bookmarked = states.get(q.id)?.bookmarked ?? false;
  const unanswered = unansweredCount(session.items, drafts);

  const answer = (response: Response) => {
    const next = submit(session, q, response, Date.now(), options);
    setDrafts(({ [session.index]: _sent, ...rest }) => rest);
    if (!exam) void record(next, [session.index]);
    set(exam && !last ? goTo(next, session.index + 1, Date.now()) : next);
  };
  const toggleBookmark = () => append([{ id: uuidv7(Date.now()), type: "bookmark", at: Date.now(), device: deviceId, bank: session.bank, question: q.id, value: !bookmarked } satisfies ProgressEvent]);
  const confirmEnd = () => (exam && unanswered ? setAsking(true) : end(session));

  return (
    <div className="sheet" data-l={running!.line ?? 0}>
      <header className="session-bar">
        <span className="ticket">{number(q.id)}</span>
        <span className="meta">{session.index + 1} {t("session.of")} {session.items.length}</span>
        {left != null && <span className="meta timer" role="timer" aria-label={t("session.left")}>{clock(left)}</span>}
        <button className="button quiet" onClick={confirmEnd}>{t("session.finish")}</button>
        {session.items.length <= 40 ? (
          <div className="track" role="progressbar" aria-label={t("session.progress")} aria-valuemin={0} aria-valuemax={session.items.length} aria-valuenow={session.items.filter((i) => i.graded).length}>
            <Line count={session.items.length} lit={session.items.map((i) => i.graded != null)} bad={exam ? undefined : session.items.map((i) => i.graded != null && !i.graded.correct)} current={session.index} />
          </div>
        ) : (
          <progress className="track" aria-label={t("session.progress")} value={session.items.filter((i) => i.graded).length} max={session.items.length} />
        )}
      </header>

      {exam && (
        <nav className="palette" ref={palette} aria-label={t("session.palette")}>
          {session.items.map((entry, k) => (
            <button
              key={k} className={`cell-btn ${k === session.index ? "current" : ""} ${entry.graded ? "done" : ""}`} aria-current={k === session.index ? "step" : undefined}
              aria-label={t(entry.graded ? "session.paletteDone" : "session.paletteOpen", { n: k + 1 })} onClick={() => set(goTo(session, k, Date.now()))}
            >{k + 1}</button>
          ))}
        </nav>
      )}

      <article className="question">
        <div className="question-meta">
          <span className="meta">{t(`mode.${item.mode}`)}{q.difficulty_level != null && ` · ${t("bank.level")} ${q.difficulty_level}`}</span>
          <button className="button quiet icon" aria-pressed={bookmarked} onClick={toggleBookmark}>
            <Bookmark size={18} strokeWidth={1.5} fill={bookmarked ? "currentColor" : "none"} aria-hidden />{bookmarked ? t("session.bookmarked") : t("session.bookmark")}
          </button>
        </div>
        {item.again != null && <p className="chip again">{t("session.again")}</p>}
        <div className="prompt" lang={language}><Rich text={text(prompt, language)} /></div>
        {fellBack(prompt, language) && <p className="meta">{t("session.shownIn")}: {language.toUpperCase()}</p>}

        <Answer
          key={`${session.index}:${locked}`} q={q} item={item} language={language} locked={locked} exam={exam} dock={dock} onSubmit={answer}
          draft={drafts[session.index] ?? {}} onDraft={(patch) => setDrafts((old) => ({ ...old, [session.index]: { ...old[session.index], ...patch } }))}
        />
        {locked && <Feedback q={q} item={item} language={language} bank={session.bank} attempt={attempts[session.index]} />}
      </article>

      {/* All the buttons that move the learner on sit in one bar at the bottom, under the thumb; the open question adds its own into `dock-main`. */}
      <footer className="dock" ref={dockBar}>
        {exam && <button className="button quiet" disabled={session.index === 0} onClick={() => set(goTo(session, session.index - 1, Date.now()))}>{t("session.prev")}</button>}
        {!locked && !last && <button className="button quiet" onClick={() => set(goTo(session, session.index + 1, Date.now()))}>{t("session.skip")}</button>}
        <div className="dock-main" ref={setDock} />
        {locked && !last && <button className="button primary" onClick={() => set(goTo(session, session.index + 1, Date.now()))}>{t("session.next")}</button>}
        {locked && last && <button className="button primary" onClick={() => end(session)}>{t("session.finish")}</button>}
        {exam && last && <button className="button" onClick={confirmEnd}>{t("session.finish")}</button>}
      </footer>
      {asking && (
        <Confirm
          title={t("session.finish")} body={t("session.confirmFinish", { count: unanswered })} stay={t("session.keepGoing")} go={t("session.finish")}
          onStay={() => setAsking(false)} onGo={() => end(session)}
        />
      )}
    </div>
  );
}
