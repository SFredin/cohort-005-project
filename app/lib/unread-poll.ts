import { useEffect, useRef, useState } from "react";
import { z } from "zod";

// ─── The Unread poll ───
// How a new Notification reaches the bell's badge without a reload: the shell
// asks a resource route for the person's Unread count on a fixed interval. It
// never asks for the list and never revalidates the page, so whatever the
// person is reading stays as it is.

/** Where the shell asks for the current person's Unread count. */
export const UNREAD_COUNT_PATH = "/api/notifications/unread-count";

/** The body `UNREAD_COUNT_PATH` answers with. */
export type UnreadCountResponse = { unreadCount: number };

const unreadCountResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});

/** Fixed: a failed check does not slow the poll down or speed it up. */
const POLL_INTERVAL_MS = 60_000;

/** The part of a browser tab the poll depends on. */
type Tab = {
  isHidden: () => boolean;
  /** Calls the listener on every change; returns how to stop listening. */
  onVisibilityChange: (listener: () => void) => () => void;
};

/**
 * Checks the Unread count every 60 seconds while the tab is visible. A hidden
 * tab makes no checks; when it becomes visible it checks once straight away
 * and the 60 seconds start again from there. A failed check is ignored.
 * Returns how to stop.
 */
export function startUnreadPoll({
  fetchCount,
  onCount,
  tab,
}: {
  fetchCount: () => Promise<number>;
  onCount: (count: number) => void;
  tab: Tab;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function check() {
    fetchCount().then(
      (count) => {
        if (!stopped) onCount(count);
      },
      () => {
        // Ignored: the badge stays as it was and the next check runs on time.
      }
    );
  }

  function pause() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function resume() {
    pause();
    timer = setInterval(check, POLL_INTERVAL_MS);
  }

  const stopListening = tab.onVisibilityChange(() => {
    if (tab.isHidden()) {
      pause();
    } else {
      check();
      resume();
    }
  });

  if (!tab.isHidden()) resume();

  return () => {
    stopped = true;
    pause();
    stopListening();
  };
}

async function fetchUnreadCount(): Promise<number> {
  const response = await fetch(UNREAD_COUNT_PATH, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Unread count: ${response.status}`);

  return unreadCountResponseSchema.parse(await response.json()).unreadCount;
}

const documentTab: Tab = {
  isHidden: () => document.hidden,
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * The Unread count to show on the bell: the app layout loader's, until a poll
 * asked after that loader ran answers with a newer one. Every later run of the
 * loader (a page load, a navigation, any form or fetcher submission such as
 * marking a Notification read) takes over again.
 *
 * Pass the layout's `loaderData` object itself: its identity is how a new
 * loader run is told from a re-render. With nobody signed in, nothing is
 * polled.
 */
export function useUnreadNotificationCount(loaderData: {
  currentUser: { id: number } | null;
  unreadNotificationCount: number;
}): number {
  const [polled, setPolled] = useState<{
    count: number;
    askedAfter: object;
  } | null>(null);

  const latestLoaderData = useRef<object>(loaderData);
  useEffect(() => {
    latestLoaderData.current = loaderData;
  }, [loaderData]);

  const personId = loaderData.currentUser?.id ?? null;
  useEffect(() => {
    if (personId === null) return;

    // An answer counts against the loader data that was on screen when the
    // question was asked, so a slow answer can't override a newer loader run.
    let askedAfter = latestLoaderData.current;
    return startUnreadPoll({
      fetchCount() {
        askedAfter = latestLoaderData.current;
        return fetchUnreadCount();
      },
      onCount: (count) => setPolled({ count, askedAfter }),
      tab: documentTab,
    });
  }, [personId]);

  return polled !== null && polled.askedAfter === loaderData
    ? polled.count
    : loaderData.unreadNotificationCount;
}
