import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { requireUserId } from "~/lib/access.server";
import { db } from "~/db";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "~/lib/notifications.server";
import { parseFormData } from "~/lib/validation";

// The bell's dropdown: the current person's Notifications, and marking them
// read. The dropdown loads this when it opens; nothing polls it.

const markReadSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("mark-read"),
    notificationId: z.coerce.number().int(),
  }),
  z.object({ intent: z.literal("mark-all-read") }),
]);

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await requireUserId(request);

  return {
    notifications: listNotifications(db, currentUserId, new Date()),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await requireUserId(request);

  const parsed = parseFormData(await request.formData(), markReadSchema);
  if (!parsed.success) {
    throw data("Invalid parameters", { status: 400 });
  }

  if (parsed.data.intent === "mark-all-read") {
    markAllNotificationsRead(db, currentUserId, new Date());
    return { ok: true };
  }

  const isOwn = markNotificationRead(
    db,
    parsed.data.notificationId,
    currentUserId,
    new Date()
  );
  if (!isOwn) {
    throw data("Notification not found", { status: 404 });
  }

  return { ok: true };
}
