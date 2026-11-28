import { data } from "react-router";
import type { Route } from "./+types/api.notifications.unread-count";
import { getCurrentUserId } from "~/lib/session";
import { countUnreadNotifications } from "~/lib/notifications.server";
import type { UnreadCountResponse } from "~/lib/unread-poll";
import { db } from "~/db";

/**
 * The current person's Unread count and nothing else. The shell polls this
 * (see `~/lib/unread-poll`); it never carries the list.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Unauthorized", { status: 401 });
  }

  const body: UnreadCountResponse = {
    unreadCount: countUnreadNotifications(db, currentUserId, new Date()),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
