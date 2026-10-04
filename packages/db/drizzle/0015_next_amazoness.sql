CREATE TABLE `workflow_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`cron` text NOT NULL,
	`task_template` text NOT NULL,
	`timezone` text NOT NULL,
	`last_fired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_schedules_workflow_id_unique` ON `workflow_schedules` (`workflow_id`);