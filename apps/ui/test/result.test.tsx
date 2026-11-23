import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@exam/core";
import type { Question } from "@exam/schema";

// The result screen of a finished exam is drawn on its own: the app, the platform and the update state are stood in for.
const app = vi.hoisted(() => ({ writes: {} as Record<string, string> }));
const q: Question = { type: "single_choice", id: 1, topic_id: 1, question: "2 + 2?", options: [{ id: "a", text: "4" }, { id: "b", text: "5" }], correct_answers: ["a"] };
const session: Session = {
  id: "s1", bank: "b1", index: 0, startedAt: 0, shownAt: 0, finishedAt: 1,
  config: { kind: "exam", answerMode: "choice", unsupported: "skip", shuffle: false, seed: 1 },
  items: [{ question: 1, mode: "choice", response: { mode: "choice", selected: ["b"] }, graded: { correct: false, score: 0 } as never }],
};
vi.mock("../src/updates.tsx", () => ({ useUpdating: () => false }));
vi.mock("../src/platform.ts", () => ({ clearSavedExam: () => {}, deviceId: "d", saveExam: () => {} }));
vi.mock("../src/ui.tsx", () => ({ Confirm: () => null, useDockHeight: () => () => {} }));
vi.mock("../src/rich.tsx", () => ({ Rich: ({ text }: { text: string }) => text }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/app.tsx", () => ({
  useApp: () => ({
    running: { session, bundle: { bank: { language: "ru", scoring: { multiple_choice: "exact" } }, questions: [q] }, back: "#/", hash: "h", setup: undefined },
    run: () => {}, text: (value: unknown) => (typeof value === "string" ? value : ""), fellBack: () => false, events: [], append: () => {}, commit: () => {},
    settings: { content: "auto", ui: "ru", unsupported: "skip" }, writes: app.writes, storePending: () => {}, retryPending: () => {},
  }),
}));

const { SessionScreen } = await import("../src/session.tsx");
const screen = (write?: string) => {
  app.writes = write ? { [session.id]: write } : {};
  return renderToStaticMarkup(<SessionScreen />);
};
const retryButton = (html: string) => html.match(/<button[^>]*>result\.fixMistakes<\/button>/)?.[0];

describe("the result of an exam while its answers are written", () => {
  test("says the answers are being saved while the buttons that start a session wait", () => {
    const html = screen("saving");
    expect(retryButton(html)).toMatch(/disabled=""/);
    expect(html).toMatch(/<p class="hint" role="status">result\.saving<\/p>/);
    expect(html).not.toContain("result.notSaved");
  });

  test("says nothing once they are saved", () => {
    const html = screen("saved");
    expect(retryButton(html)).not.toMatch(/disabled/);
    expect(html).not.toContain("result.saving");
  });

  test("a failed write keeps its own message and Save again, not the saving line", () => {
    const html = screen("failed");
    expect(html).toContain("result.notSaved");
    expect(html).toContain("result.saveAgain");
    expect(html).not.toContain("result.saving");
  });
});
