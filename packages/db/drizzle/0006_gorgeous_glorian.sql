CREATE TABLE `project_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`value_enc` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_secrets_project_id_name_unique` ON `project_secrets` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `project_secrets_project_id_idx` ON `project_secrets` (`project_id`);