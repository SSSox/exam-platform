/**
 * What takes the Back button before the history does: a sheet that is open, an exam that holds answers. The newest comes first.
 * Only the Android shell hands the button over (`ExamSystemBars.holdBack`, then `examBack`); a browser keeps its own Back.
 */
const takers: (() => void)[] = [];

function sync(): void {
  window.ExamSystemBars?.holdBack(takers.length > 0);
  window.examBack = takers.length ? () => takers.at(-1)!() : undefined;
}

// A reload drops the page without its cleanups, and the shell keeps Back for as long as it was last told to (the data wipe reloads with its question open).
// So every new page starts by telling the shell what it holds: nothing yet. Outside a browser (tests) there is no window to tell.
if (typeof window !== "undefined") sync();

/** Asks for the Back button; the returned function gives it back. */
export function takeBack(run: () => void): () => void {
  const taker = () => run();
  takers.push(taker);
  sync();
  return () => {
    const at = takers.indexOf(taker);
    if (at >= 0) takers.splice(at, 1);
    sync();
  };
}
