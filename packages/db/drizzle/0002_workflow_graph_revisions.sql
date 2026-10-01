CREATE TABLE `workflow_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`number` integer NOT NULL,
	`graph` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_revisions_workflow_id_number_unique` ON `workflow_revisions` (`workflow_id`,`number`);--> statement-breakpoint
CREATE INDEX `workflow_revisions_workflow_id_idx` ON `workflow_revisions` (`workflow_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `workflow_revision_id` text REFERENCES workflow_revisions(id);--> statement-breakpoint
ALTER TABLE `workflows` ADD `latest_revision_number` integer;