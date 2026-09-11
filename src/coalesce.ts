/**
 * One run at a time, and at most one more after it.
 *
 * For work that re-reads something and draws it. A request that arrives while a run is going is news
 * the run may have read too early for, so one more run follows - but only one, however many arrived,
 * because that one reads everything they would have. Two side by side would be the same question
 * asked twice at once, and on a large repository `git status` is the better part of a second each.
 *
 * Every caller gets a promise that settles once a run that started after its request has finished.
 */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;

  return () => {
    if (running !== null) {
      again = true;
      return running;
    }

    running = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        running = null;
      }
    })();

    return running;
  };
}
