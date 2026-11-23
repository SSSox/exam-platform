import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Question } from "@exam/schema";

// The card is drawn on its own: the app, the session screen and the update state are stood in for, so only the card's own markup is checked.
const update = vi.hoisted(() => ({ updating: false }));
vi.mock("../src/updates.tsx", () => ({ useUpdating: () => update.updating }));
vi.mock("../src/app.tsx", () => ({ useApp: () => ({ text: (value: unknown) => (typeof value === "string" ? value : "") }) }));
vi.mock("../src/session.tsx", () => ({ useRightAnswer: () => () => [], Reference: () => null }));
vi.mock("../src/rich.tsx", () => ({ Rich: ({ text }: { text: string }) => text }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { Peek } = await import("../src/peek.tsx");

const q: Question = { type: "single_choice", id: 7, topic_id: 1, question: "2 + 2?", options: [{ id: "a", text: "4" }, { id: "b", text: "5" }], correct_answers: ["a"] };
const noop = () => {};
const card = () => renderToStaticMarkup(
  <Peek
    q={q} language="ru" topic="Arithmetic" status="new" due={false} tries={{ count: 0, right: 0 }} bookmarked={false} place={{ at: 0, of: 1 }}
    onClose={noop} onStep={noop} onAnswer={noop} onBookmark={noop}
  />,
);
const answerButton = (html: string) => html.match(/<button[^>]*>peek\.answer<\/button>/)?.[0];

describe("the question card opened from the map", () => {
  test("Answer starts a session as usual when no update is on its way", () => {
    update.updating = false;
    const html = card();
    expect(answerButton(html)).toBeDefined();
    expect(answerButton(html)).not.toMatch(/disabled/);
    expect(html).not.toContain("update.waitToStart");
  });

  test("Answer is held while a new version downloads or installs, with the same words as the bank's Start", () => {
    update.updating = true;
    const html = card();
    expect(answerButton(html)).toMatch(/disabled=""/);
    expect(html).toContain("update.waitToStart");
  });
});
