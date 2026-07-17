CREATE TABLE `task_run` (
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
);
CREATE INDEX `task_run_parent_idx` ON `task_run` (`parent_session_id`);
CREATE INDEX `task_run_status_idx` ON `task_run` (`status`);
