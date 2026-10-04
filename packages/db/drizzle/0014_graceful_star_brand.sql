CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`webhook_id` text NOT NULL,
	`outcome` text NOT NULL,
	`status_code` integer NOT NULL,
	`auth_mode` text,
	`run_id` text,
	`error_code` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_id_idx` ON `webhook_deliveries` (`webhook_id`);--> statement-breakpoint
CREATE TABLE `workflow_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`secret_enc` text NOT NULL,
	`default_task` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_webhooks_workflow_id_unique` ON `workflow_webhooks` (`workflow_id`);