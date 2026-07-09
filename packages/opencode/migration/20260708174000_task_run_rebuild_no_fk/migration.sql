DROP TABLE IF EXISTS `task_run_no_session_fk`;--> statement-breakpoint
DROP INDEX IF EXISTS `task_run_parent_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `task_run_status_idx`;--> statement-breakpoint
CREATE TABLE `task_run_no_session_fk` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_session_id` text NOT NULL,
	`description` text NOT NULL,
	`subagent_type` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`result_summary` text,
	`last_error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `task_run_no_session_fk` (
	`id`,
	`parent_session_id`,
	`description`,
	`subagent_type`,
	`mode`,
	`status`,
	`started_at`,
	`finished_at`,
	`result_summary`,
	`last_error`,
	`time_created`,
	`time_updated`
)
SELECT
	`id`,
	`parent_session_id`,
	`description`,
	`subagent_type`,
	`mode`,
	`status`,
	`started_at`,
	`finished_at`,
	`result_summary`,
	`last_error`,
	`time_created`,
	`time_updated`
FROM `task_run`;--> statement-breakpoint
DROP TABLE `task_run`;--> statement-breakpoint
ALTER TABLE `task_run_no_session_fk` RENAME TO `task_run`;--> statement-breakpoint
CREATE INDEX `task_run_parent_idx` ON `task_run` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `task_run_status_idx` ON `task_run` (`status`);
