import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useFetcher, useSubmit } from "react-router";
import {
  Bell,
  CornerDownRight,
  MessageSquare,
  Receipt,
  UsersRound,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { NotificationKind } from "~/db/schema";
import { NOTIFICATIONS_PATH, NotificationIntent } from "~/lib/notifications";
import type { NotificationForRecipient } from "~/lib/notifications.server";
import { cn, formatRelativeTime } from "~/lib/utils";
import type { loader as notificationsLoader } from "~/routes/api.notifications";

/** The badge stops counting here and shows "9+". */
const BADGE_CAP = 9;

const KIND_ICON: Record<NotificationKind, ReactNode> = {
  [NotificationKind.RefundRequestOpened]: <Receipt className="size-4" />,
  [NotificationKind.RefundRequestDecided]: <Receipt className="size-4" />,
  [NotificationKind.SeatClaimed]: <UsersRound className="size-4" />,
  [NotificationKind.QuestionPosted]: <MessageSquare className="size-4" />,
  [NotificationKind.ReplyPosted]: <CornerDownRight className="size-4" />,
};

function unreadLabel(unreadCount: number) {
  return unreadCount > BADGE_CAP ? `${BADGE_CAP}+` : String(unreadCount);
}

/**
 * The bell at the top of the sidebar, with a red badge counting the person's
 * Unread Notifications. Clicking it opens a dropdown with their Notifications.
 * Render it only for a signed-in person.
 *
 * `unreadCount` drives the badge. Marking read reruns the layout loader, which
 * supplies the new count.
 */
export function NotificationBell({ unreadCount }: { unreadCount: number }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative ml-auto rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadLabel(unreadCount)} unread`
              : "Notifications"
          }
        >
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
            >
              {unreadLabel(unreadCount)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-96 overflow-hidden rounded-lg p-0 shadow-lg"
      >
        <NotificationDropdown
          unreadCount={unreadCount}
          onRowClick={() => setIsOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the open dropdown shows. It is mounted only while the dropdown is open,
 * so every opening starts without a list and loads one; opening marks nothing
 * read.
 *
 * The list is loaded again whenever the badge's count stops matching it, so a
 * Notification that arrives while the dropdown is open shows up in it. The
 * count is the only thing the poll carries; the list always comes from here.
 */
function NotificationDropdown({
  unreadCount,
  onRowClick,
}: {
  unreadCount: number;
  onRowClick: () => void;
}) {
  const list = useFetcher<typeof notificationsLoader>();
  const markRead = useFetcher();
  const submit = useSubmit();

  const notifications = list.data?.notifications;
  const unreadInList = notifications?.filter(
    (notification) => notification.isUnread
  ).length;
  const hasUnread = unreadInList !== undefined && unreadInList > 0;

  const { load } = list;
  useEffect(() => {
    if (unreadInList !== unreadCount) load(NOTIFICATIONS_PATH);
    // Only a new count asks again. `unreadInList` is left out so that a list
    // which still disagrees after loading does not load in a loop.
  }, [unreadCount, load]);

  function handleRowClick(
    event: MouseEvent<HTMLAnchorElement>,
    notification: NotificationForRecipient
  ) {
    onRowClick();
    if (!notification.isUnread) return;

    const fields = { notificationId: notification.id };
    const opensElsewhere =
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey;
    if (opensElsewhere) {
      // The browser opens the link in another tab or window; this one stays.
      markRead.submit(
        { ...fields, intent: NotificationIntent.MarkRead },
        { method: "post", action: NOTIFICATIONS_PATH }
      );
      return;
    }

    // Marked read first, then on to the link: the action redirects there once
    // the Notification is read, and not at all if marking it failed.
    event.preventDefault();
    submit(
      { ...fields, intent: NotificationIntent.Open },
      { method: "post", action: NOTIFICATIONS_PATH }
    );
  }

  function handleMarkAllRead() {
    markRead.submit(
      { intent: NotificationIntent.MarkAllRead },
      { method: "post", action: NOTIFICATIONS_PATH }
    );
  }

  return (
    <>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">Notifications</span>
        {hasUnread && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="text-xs text-primary hover:underline"
          >
            Mark all as read
          </button>
        )}
        {notifications && notifications.length > 0 && !hasUnread && (
          <span className="text-xs text-muted-foreground">
            You're all caught up
          </span>
        )}
      </div>
      {notifications && (
        <div className="max-h-[26rem] divide-y overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              <Bell className="mx-auto mb-2 size-5 opacity-50" />
              Nothing here yet
            </div>
          ) : (
            notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onClick={(event) => handleRowClick(event, notification)}
              />
            ))
          )}
        </div>
      )}
    </>
  );
}

/** One Notification. The whole row is the link to what it is about. */
function NotificationRow({
  notification,
  onClick,
}: {
  notification: NotificationForRecipient;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { isUnread } = notification;

  return (
    <Link
      to={notification.link}
      onClick={onClick}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent"
    >
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          isUnread
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        {KIND_ICON[notification.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm",
            isUnread ? "font-medium text-foreground" : "text-muted-foreground"
          )}
        >
          {notification.sentence}
        </span>
        <span
          className="mt-0.5 block text-xs text-muted-foreground"
          suppressHydrationWarning
        >
          {formatRelativeTime(notification.createdAt)}
        </span>
      </span>
      {isUnread && (
        <>
          <span className="sr-only">Unread</span>
          <span
            aria-hidden="true"
            className="mt-2 size-2 shrink-0 rounded-full bg-primary"
          />
        </>
      )}
    </Link>
  );
}
