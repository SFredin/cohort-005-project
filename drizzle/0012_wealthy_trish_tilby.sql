CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_id` integer NOT NULL,
	`kind` text NOT NULL,
	`sentence` text NOT NULL,
	`link` text NOT NULL,
	`refund_request_id` integer,
	`created_at` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_refund_request_idx` ON `notifications` (`refund_request_id`);