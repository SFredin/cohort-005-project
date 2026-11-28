// What the bell and its resource route agree on. Safe to import in the browser;
// everything that touches the notifications table is in `notifications.server`.

/** The resource route the dropdown loads its list from and marks read on. */
export const NOTIFICATIONS_PATH = "/api/notifications";

/** What a POST to `NOTIFICATIONS_PATH` can ask for. */
export const NotificationIntent = {
  /** Marks one Notification read, then redirects to its link. */
  Open: "open",
  /** Marks one Notification read and stays on the page. */
  MarkRead: "mark-read",
  MarkAllRead: "mark-all-read",
} as const;
