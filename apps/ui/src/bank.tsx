import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronDown, SlidersHorizontal } from "lucide-react";
import { bankStats, createSession, entriesOf, modeFor, pickAdaptive, placeOf, project, uuidv7, walk, type AnswerMode, type SessionConfig, type Status as QuestionStatus } from "@exam/core";
import type { Question } from "@exam/schema";
import { client, deviceId, storePlace } from "./platform.ts";
import { Status, useApp, useAsync } from "./app.tsx";
import { hashOf, load } from "./catalog.tsx";
import { rememberHome } from "./home.ts";
import { Segmented, Select, SideSheet, useDockHeight, useWide } from "./ui.tsx";
import { Peek } from "./peek.tsx";
import { STATUSES, StatusMark } from "./status.tsx";
import { Stops, stopsOf } from "./stops.tsx";
import { homeOf, lineOf, pageAbove, pathNames, stationsOf } from "./lib.ts";

type Filter = QuestionStatus | "due" | null;
type Scope = "smart" | "all" | "mistakes" | "bookmarks";

/**
 * The questions of one topic as a grid of squares. Each square opens its question. The grid is one tab stop:
 * Tab enters it, the arrow keys move between squares (up and down follow the rows as they wrap), Home and End jump to the ends.
 */
function Cells({ questions, label, status, due, filter, onOpen }: {
  questions: Question[]; label: string; status: (id: number) => QuestionStatus; due: (id: number) => boolean; filter: Filter; onOpen(id: number): void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(0);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (e: KeyboardEvent, from: number) => {
    const els = cells.current.slice(0, questions.length) as HTMLButtonElement[];
    let to = from;
    if (e.key === "ArrowRight") to = from + 1;
    else if (e.key === "ArrowLeft") to = from - 1;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = els.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const here = els[from]!.getBoundingClientRect();
      let best = Infinity;
      els.forEach((el, i) => {
        const box = el.getBoundingClientRect();
        if ((box.top - here.top) * dir <= 4) return;
        const score = Math.abs(box.top - here.top) * 1000 + Math.abs(box.left - here.left);
        if (score < best) [best, to] = [score, i];
      });
      if (best === Infinity) return;
    } else return;
    to = Math.max(0, Math.min(els.length - 1, to));
    e.preventDefault();
    setTab(to);
    els[to]!.focus();
  };

  return (
    <div className="cells" role="group" aria-label={label}>
      {questions.map((q, i) => {
        const st = status(q.id);
        const isDue = due(q.id);
        const dim = filter != null && (filter === "due" ? !isDue : st !== filter);
        return (
          <button
            key={q.id} type="button" ref={(el) => void (cells.current[i] = el)} tabIndex={i === Math.min(tab, questions.length - 1) ? 0 : -1}
            className={`cell cell-${st}${isDue ? " due" : ""}${dim ? " dim" : ""}`} title={`№ ${q.id}`}
            aria-label={`№ ${q.id}, ${t(`bank.legend.${st}`)}${isDue ? `, ${t("bank.due")}` : ""}`}
            onClick={() => onOpen(q.id)} onFocus={() => setTab(i)} onKeyDown={(e) => move(e, i)}
          />
        );
      })}
    </div>
  );
}

export function BankScreen({ node, bank: bankId }: { node: string; bank: string }) {
  const { t } = useTranslation();
  const { index, events, text, settings, run, append } = useApp();
  const loaded = useAsync(async () => {
    const chain = await walk(index!.roots, node, load);
    const folder = chain.at(-1);
    if (!folder || folder.id !== node) throw new Error(`no such section: ${node}`);
    const ref = folder.banks.find((b) => b.id === bankId);
    if (!ref) throw new Error(`no such bank: ${bankId}`);
    const line = lineOf(entriesOf(folder).findIndex((e) => e.ref.id === bankId));
    return { chain, ref, line, bundle: await client.bank(ref.hash) };
  }, [node, bankId, index?.version]);

  // A semester that holds one bank never shows its own page, so the bank page is where its place gets remembered.
  useEffect(() => {
    const place = loaded.data && placeOf(loaded.data.chain, index!.kinds);
    if (!loaded.data || !place) return;
    storePlace(place);
    rememberHome(hashOf(homeOf(loaded.data.chain, place)));
  }, [loaded.data, index]);

  const [scope, setScope] = useState<Scope>("smart");
  const [answerMode, setAnswerMode] = useState<AnswerMode>("choice");
  const [kind, setKind] = useState<"practice" | "exam">("practice");
  const [topics, setTopics] = useState<number[]>([]);
  const [level, setLevel] = useState(0);
  const [count, setCount] = useState(20);
  const [minutes, setMinutes] = useState(20);
  const [nothing, setNothing] = useState(false);
  // "Nothing fits" is about the settings it was shown for: any change of them takes it back.
  useEffect(() => setNothing(false), [scope, kind, answerMode, topics, level, count]);
  const [filter, setFilter] = useState<Filter>(null);
  const dockBar = useDockHeight();
  // Beside the map the preparation panel is a column; where there is no room for one it slides in from the right (`SideSheet`).
  const wide = useWide();
  const [setupOpen, setSetupOpen] = useState(false);
  useEffect(() => {
    if (wide) setSetupOpen(false);
  }, [wide]);
  const [open, setOpen] = useState<number>();
  // Topics show their squares only once opened: a long bank would otherwise be a page of squares with the way on at its very end.
  const [expanded, setExpanded] = useState<number[]>([]);

  // Which questions are due depends on the clock, so a page left open recounts once a minute.
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const view = useMemo(() => {
    if (!loaded.data) return undefined;
    const { bank, questions } = loaded.data.bundle;
    const states = project(events, bank.id);
    const now = Date.now();
    return { states, now, stats: bankStats(states, questions, now), active: questions.filter((q) => !q.retired) };
  }, [loaded.data, events, minute]);
  if (!loaded.data || !view) return <Status error={loaded.error} reload={loaded.reload} />;

  const { chain, ref, bundle, line } = loaded.data;
  const stations = stationsOf(index!.roots, chain);
  const { bank } = bundle;
  const { states, stats, active, now } = view;
  const dueSet = new Set(stats.due);
  const statusOf = (id: number): QuestionStatus => stats.status.get(id) ?? "new";
  const counts = (st: QuestionStatus) => [...stats.status.values()].filter((x) => x === st).length;
  const mastery = Math.round(stats.mastery * 100);
  const percent = (correct: number, attempts: number) => (attempts ? `${Math.round((correct / attempts) * 100)}%` : "0%");
  const title = text(bank.subject, bank.language);
  const toggle = (id: number) => setTopics((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  const expand = (id: number) => setExpanded((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  /** A status picked in the legend opens exactly the topics that hold such questions: the squares are what the filter is for. */
  const pickFilter = (c: Exclude<Filter, null>) => {
    const next = filter === c ? null : c;
    setFilter(next);
    if (next) setExpanded(bank.topics.filter((tp) => active.some((q) => q.topic_id === tp.id && (next === "due" ? dueSet.has(q.id) : statusOf(q.id) === next))).map((tp) => tp.id));
  };

  /** What the chosen topics and difficulty let through: the session and the count on Start both go by it. */
  const fits = (q: Question) => (!topics.length || topics.includes(q.topic_id)) && (!level || q.difficulty_level === level);

  /** `only` opens a session on that one question, whatever the panel says. */
  const start = (only?: Question) => {
    const practice = only != null || kind === "practice";
    const smart = !only && practice && scope === "smart";
    const seed = Date.now() % 2 ** 31;
    let ids = only ? [only.id] : scope === "mistakes" ? stats.mistakes : scope === "bookmarks" ? stats.bookmarks : undefined;
    if (smart) {
      // Only questions the chosen answer mode can ask, or the draw could hand the session questions it then drops.
      const pool = active.filter((q) => fits(q) && modeFor(q, { answerMode, unsupported: settings.unsupported }));
      ids = pickAdaptive(pool, states, Date.now(), count || undefined, seed);
    }
    if (only) setOpen(undefined);
    if (ids && !ids.length) return setNothing(true);
    // A question opened from the map is always asked, in the nearest mode it supports.
    const config: SessionConfig = {
      kind: practice ? "practice" : "exam", answerMode, unsupported: only ? "self_check" : settings.unsupported, shuffle: true, seed, keepOrder: smart, relearn: practice,
      topics: only ? [] : topics, levels: !only && level ? [level] : undefined, ids, count: only ? 1 : count || undefined,
      timeLimitSec: !practice && minutes ? minutes * 60 : undefined, passPercent: !practice ? 50 : undefined,
    };
    const session = createSession(bank.id, bundle.questions, config, Date.now(), uuidv7(Date.now()));
    if (!session.items.length) return setNothing(true);
    setOpen(undefined);
    run({ session, bundle, back: location.hash, line, hash: ref.hash });
    location.hash = "#/session";
  };

  const toggleBookmark = (q: Question) => void append([{ id: uuidv7(Date.now()), type: "bookmark", at: Date.now(), device: deviceId, bank: bank.id, question: q.id, value: !states.get(q.id)?.bookmarked }]);
  const opened = open != null ? active.find((q) => q.id === open) : undefined;
  const walkList = opened ? active.filter((q) => q.topic_id === opened.topic_id) : [];
  const attemptsOf = (id: number) => Object.values(states.get(id)?.modes ?? {}).reduce((sum, m) => ({ count: sum.count + m.attempts, right: sum.right + m.correct }), { count: 0, right: 0 });

  /** What Start would do, in a few words: it sits on the Start button, where the panel is out of sight. */
  const sheet = setupOpen && !wide;
  const scopeTitle = t(scope === "smart" ? "bank.smart" : scope === "all" ? "bank.all" : scope === "mistakes" ? "bank.mistakes" : "bank.bookmarks");
  // The session cannot be longer than what the scope holds under the chosen topics and difficulty, whatever the number asked for says (0 means all of it).
  const listIds = scope === "mistakes" ? new Set(stats.mistakes) : scope === "bookmarks" ? new Set(stats.bookmarks) : undefined;
  const inScope = active.filter((q) => (!listIds || listIds.has(q.id)) && fits(q)).length;
  const asked = Math.min(count || inScope, inScope);
  const summary = [
    kind === "exam" ? t("bank.exam") : scopeTitle,
    kind === "exam" && scope !== "all" && scopeTitle,
    asked > 0 && t("catalog.questions", { count: asked }),
    level > 0 && `${t("bank.level")} ${level}`,
    kind === "exam" && minutes > 0 && t("bank.minutesShort", { n: minutes }),
    answerMode === "typed" && t("mode.typed"),
    topics.length > 0 && `${t("bank.topics")}: ${topics.length}`,
  ].filter(Boolean).join(" · ");

  // The overview and the controls: the column shows the overview first, the sheet the controls, which are what it was opened for.
  const overview = (
    <>
      <div className="mastery">
        <p className="mastery-head"><span className="mastery-number">{mastery}<small>%</small></span><span>{t("bank.mastered")}</span></p>
        <progress className="meter-bar" value={mastery} max={100} aria-label={t("bank.mastered")} />
        <p className="hint">{t("bank.masteryHint")}</p>
      </div>
      <dl className="stats">
        <div><dt>{t("bank.answered")}</dt><dd>{stats.seen}<small> / {stats.questions}</small></dd></div>
        <div><dt>{t("bank.due")}</dt><dd>{stats.due.length}</dd></div>
        <div><dt>{t("bank.mistakes")}</dt><dd>{stats.mistakes.length}</dd></div>
      </dl>
      <dl className="stats modes">
        <div><dt>{t("mode.choice")}</dt><dd>{percent(stats.byMode.choice.correct, stats.byMode.choice.attempts)}</dd></div>
        <div><dt>{t("mode.typed")}</dt><dd>{percent(stats.byMode.typed.correct + stats.byMode.self_check.correct, stats.byMode.typed.attempts + stats.byMode.self_check.attempts)}</dd></div>
      </dl>
    </>
  );

  const controls = (
    <>
      <Segmented<AnswerMode> label={t("bank.how")} value={answerMode} onChange={setAnswerMode} options={[
        { value: "choice", title: t("mode.choice"), hint: t("mode.choiceHint") },
        { value: "typed", title: t("mode.typed"), hint: t("mode.typedHint") },
      ]} />
      {answerMode === "typed" && <p className="hint">{t("bank.typedShare", { typed: ref.typed, total: ref.questions })}</p>}

      <Segmented<"practice" | "exam"> label={t("bank.format")} value={kind} onChange={(v) => { setKind(v); if (v === "exam" && scope === "smart") setScope("all"); }} options={[
        { value: "practice", title: t("bank.practice"), hint: t("bank.practiceHint") },
        { value: "exam", title: t("bank.exam"), hint: t("bank.examHint") },
      ]} />

      <Segmented<Scope> wrap label={t("bank.what")} value={scope} onChange={setScope} options={[
        { value: "smart", title: t("bank.smart"), disabled: kind === "exam" },
        { value: "all", title: t("bank.all") },
        { value: "mistakes", title: `${t("bank.mistakes")} ${stats.mistakes.length}`, disabled: !stats.mistakes.length },
        { value: "bookmarks", title: `${t("bank.bookmarks")} ${stats.bookmarks.length}`, disabled: !stats.bookmarks.length },
      ]} />
      {scope === "smart" && (
        <p className="hint">{t("bank.smartHint")}. {t("bank.smartPlan", { weak: stats.mistakes.length, due: stats.due.filter((id) => !stats.mistakes.includes(id)).length, fresh: counts("new") })}</p>
      )}

      <div className="field-row">
        {bank.difficulty_scale && (
          <label className="field">
            <span>{t("bank.level")}</span>
            <Select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              <option value={0}>{t("bank.anyLevel")}</option>
              {bank.difficulty_scale.map((s) => <option key={s.level} value={s.level}>{s.level} · {text(s.title, bank.language)}</option>)}
            </Select>
          </label>
        )}
        <label className="field narrow">
          <span>{t("bank.count")}</span>
          <input type="number" min={0} max={ref.questions} value={count} onChange={(e) => setCount(Math.max(0, Number(e.target.value)))} />
        </label>
        {kind === "exam" && (
          <label className="field narrow">
            <span>{t("bank.minutes")}</span>
            <input type="number" min={0} value={minutes} onChange={(e) => setMinutes(Math.max(0, Number(e.target.value)))} />
          </label>
        )}
      </div>
      <div className="field-row topics-set">
        <p className="hint">{topics.length ? `${t("bank.topics")}: ${topics.length}` : t("bank.allTopics")}</p>
        {topics.length > 0 && <button type="button" className="button quiet" onClick={() => setTopics([])}>{t("bank.resetTopics")}</button>}
      </div>
    </>
  );

  return (
    <div className="bank" data-l={line}>
      <header className="bank-head">
        <div className="bank-nav">
          <Stops stops={stopsOf(stations, (node) => text(node.title), bank.id)} />
        </div>
        <h1>{title}</h1>
        <p className="names">{pathNames(stations.map((s) => text(s.node.title)), false)}</p>
        <p className="sub">
          {t("catalog.questions", { count: ref.questions })} · {!wide && `${t("bank.mastered")} ${mastery}% · `}{t("catalog.available")}: {ref.locales.map((l) => l.toUpperCase()).join(", ")}
        </p>
      </header>

      <div className="bank-body">
        <section aria-labelledby="map">
          <div className="section-head">
            <h2 id="map">{t("bank.map")}</h2>
            <ul className="legend" aria-label={t("bank.filter")}>
              {([...STATUSES, "due"] as const).map((c) => {
                const n = c === "due" ? stats.due.length : counts(c);
                return (
                  <li key={c}>
                    <button type="button" className="legend-item" aria-pressed={filter === c} disabled={!n} onClick={() => pickFilter(c)}>
                      <StatusMark status={c === "due" ? "new" : c} due={c === "due"} />{t(`bank.legend.${c}`)}<span className="meta">{n}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="hint map-hint">{t("bank.mapHint")}</p>
          <ul className="topics">
            {bank.topics.map((topic) => {
              const share = stats.byTopicMastery.get(topic.id)?.mastery ?? 0;
              const name = text(topic.name, bank.language);
              const shown = expanded.includes(topic.id);
              return (
                <li key={topic.id} className={shown ? "card open" : "card"}>
                  <div className="topic">
                    <label className="topic-check">
                      <input type="checkbox" aria-label={`${t("bank.topics")}: ${name}`} checked={topics.includes(topic.id)} onChange={() => toggle(topic.id)} />
                    </label>
                    <button type="button" className="topic-toggle" aria-expanded={shown} aria-controls={`topic-${topic.id}`} onClick={() => expand(topic.id)}>
                      <span className="topic-name">{name}</span>
                      <span className="meta">{t("bank.topicMastery", { percent: Math.round(share * 100) })}</span>
                      <ChevronDown className="chev" size={18} strokeWidth={1.5} aria-hidden />
                    </button>
                  </div>
                  <span className="meter" aria-hidden><i style={{ width: `${Math.round(share * 100)}%` }} /></span>
                  {shown && (
                    <div id={`topic-${topic.id}`}>
                      <Cells
                        questions={active.filter((q) => q.topic_id === topic.id)} label={name} status={statusOf} due={(id) => dueSet.has(id)} filter={filter}
                        onOpen={setOpen}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {wide && <aside className="card panel" aria-label={t("bank.setup")}>{overview}{controls}</aside>}
      </div>

      {/* The two things done most, the way back and the start, stay at the bottom of the screen whatever the page is scrolled to. */}
      <div className="dock" ref={dockBar}>
        {nothing && !sheet && <p className="hint warn" role="alert">{t("bank.nothing")}</p>}
        <a className="pill back" href={`#/n/${pageAbove(chain)}`}><ArrowLeft size={18} strokeWidth={1.5} aria-hidden />{t("nav.back")}</a>
        {!wide && (
          <button type="button" className="button dock-setup" aria-haspopup="dialog" aria-label={t("bank.setup")} title={t("bank.setup")} onClick={() => setSetupOpen(true)}>
            <SlidersHorizontal size={18} strokeWidth={1.5} aria-hidden /><span>{t("bank.setupShort")}</span>
          </button>
        )}
        <button className="button primary big start" onClick={() => start()}>
          <span>{t("bank.start")}</span>
          {!wide && <small>{summary}</small>}
        </button>
      </div>

      {sheet && (
        <SideSheet
          title={t("bank.setup")} closeLabel={t("bank.setupClose")} onClose={() => setSetupOpen(false)}
          foot={<>
            {nothing && <p className="hint warn" role="alert">{t("bank.nothing")}</p>}
            <button type="button" className="button primary big" onClick={() => start()}>{t("bank.start")}</button>
          </>}
        >
          {controls}{overview}
        </SideSheet>
      )}

      {opened && (
        <Peek
          q={opened} language={bank.language} topic={text(bank.topics.find((x) => x.id === opened.topic_id)?.name, bank.language)}
          status={statusOf(opened.id)} due={dueSet.has(opened.id)} memory={states.get(opened.id)?.memory} tries={attemptsOf(opened.id)}
          bookmarked={states.get(opened.id)?.bookmarked ?? false} place={{ at: walkList.findIndex((x) => x.id === opened.id), of: walkList.length }}
          onClose={() => setOpen(undefined)} onStep={(d) => setOpen(walkList[walkList.findIndex((x) => x.id === opened.id) + d]?.id)}
          onAnswer={() => start(opened)} onBookmark={() => toggleBookmark(opened)}
        />
      )}
    </div>
  );
}
