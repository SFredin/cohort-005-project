import { Bell } from "lucide-react";

/** The badge stops counting here and shows "9+". */
const BADGE_CAP = 9;

function unreadLabel(unreadCount: number) {
  return unreadCount > BADGE_CAP ? `${BADGE_CAP}+` : String(unreadCount);
}

/**
 * The bell at the top of the sidebar, with a red badge counting the person's
 * Unread Notifications. Render it only for a signed-in person.
 */
export function NotificationBell({ unreadCount }: { unreadCount: number }) {
  return (
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
  );
}
