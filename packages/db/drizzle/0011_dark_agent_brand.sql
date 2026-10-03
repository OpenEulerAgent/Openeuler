ALTER TABLE `runs` ADD `parent_run_id` text;--> statement-breakpoint
CREATE INDEX `runs_parent_run_id_idx` ON `runs` (`parent_run_id`);