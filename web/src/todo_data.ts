import * as z from "zod/mini";

import * as blueslip from "./blueslip.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import type {TodoAssignee} from "./todo_assignee_pill.ts";

// Any single user should send add a finite number of tasks
// to a todo list. We arbitrarily pick this value.
const MAX_IDX = 1000;

const assignee_schema = z.object({user_id: z.int(), email: z.string()});

export const todo_widget_extra_data_schema = z.object({
    task_list_title: z.optional(z.string()),
    tasks: z.optional(
        z.array(z.object({task: z.string(), desc: z.string(), deadline: z.optional(z.string())})),
    ),
    // The user the list is shared with (by direct message), if any.
    assignee: z.optional(z.nullable(assignee_schema)),
});

export type TodoWidgetExtraData = z.infer<typeof todo_widget_extra_data_schema>;

const todo_widget_inbound_data = z.intersection(
    z.object({
        type: z.enum([
            "new_task",
            "new_task_list_title",
            "strike",
            "edit_task",
            "start_task",
            "reset_task",
        ]),
    }),
    z.record(z.string(), z.unknown()),
);

// TODO: This schema is being used to parse two completely
// different types of things (inbound and outbound data),
// which should be refactored so that the code here is
// clearer and less confusing.
const new_task_inbound_data_schema = z.object({
    type: z.optional(z.literal("new_task")),
    key: z.int().check(z.nonnegative(), z.lte(MAX_IDX)),
    task: z.string(),
    desc: z.string(),
    deadline: z.optional(z.string()),
    completed: z.boolean(),
});

type NewTaskOutboundData = z.output<typeof new_task_inbound_data_schema>;

type NewTaskTitleOutboundData = {
    type: "new_task_list_title";
    title: string;
};

type TaskStrikeOutboundData = {
    type: "strike";
    key: string;
};

type TaskEditOutboundData = {
    type: "edit_task";
    key: string;
    desc: string;
    deadline: string;
};

type TaskStartOutboundData = {
    type: "start_task";
    key: string;
};

type TaskResetOutboundData = {
    type: "reset_task";
    key: string;
};

type TodoTask = {
    task: string;
    desc: string;
    deadline?: string | undefined;
};

type Task = {
    task: string;
    desc: string;
    deadline?: string | undefined;
    idx: number;
    key: string;
    completed: boolean;
    // Set by the assignee, in lists with an assignee; a task must be
    // started before it can be checked off.
    in_progress: boolean;
    status_icon?: string;
    locked?: boolean;
    lock_reason?: string;
    can_start?: boolean;
    can_reset?: boolean;
};

export type TodoWidgetOutboundData =
    | NewTaskTitleOutboundData
    | NewTaskOutboundData
    | TaskStrikeOutboundData
    | TaskEditOutboundData
    | TaskStartOutboundData
    | TaskResetOutboundData;

export class TaskData {
    message_sender_id: number;
    me: number;
    input_mode: boolean;
    report_error_function: (msg: string, more_info?: Record<string, unknown>) => void;
    task_list_title: string;
    assignee: TodoAssignee | undefined;
    task_map = new Map<string, Task>();
    my_idx = 1;

    handle = {
        new_task_list_title: {
            outbound: (title: string): NewTaskTitleOutboundData | undefined => {
                const event = {
                    type: "new_task_list_title" as const,
                    title,
                };
                if (this.is_my_task_list()) {
                    return event;
                }
                return undefined;
            },

            inbound: (sender_id: number, raw_data: unknown): void => {
                // Only the message author can edit questions.
                const new_task_title_inbound_data = z.object({
                    type: z.literal("new_task_list_title"),
                    title: z.string(),
                });
                const parsed = new_task_title_inbound_data.safeParse(raw_data);

                if (!parsed.success) {
                    this.report_error_function(
                        "todo widget: bad type for inbound task list title",
                        {error: parsed.error},
                    );
                    return;
                }
                const data = parsed.data;
                if (sender_id !== this.message_sender_id) {
                    this.report_error_function(
                        `user ${sender_id} is not allowed to edit the task list title`,
                    );
                    return;
                }

                this.set_task_list_title(data.title);
            },
        },

        new_task: {
            outbound: (
                task: string,
                desc: string,
                deadline?: string,
            ): NewTaskOutboundData | undefined => {
                this.my_idx += 1;
                const event = {
                    type: "new_task" as const,
                    key: this.my_idx,
                    task,
                    desc,
                    deadline: deadline ?? "",
                    completed: false,
                };

                if (!this.name_in_use(task)) {
                    return event;
                }
                return undefined;
            },

            inbound: (sender_id: number | string, raw_data: unknown): void => {
                // All readers may add tasks. For legacy reasons, the
                // inbound idx is called key in the event.

                const parsed = new_task_inbound_data_schema.safeParse(raw_data);
                if (!parsed.success) {
                    blueslip.warn("todo widget: bad type for inbound task data", {
                        error: parsed.error,
                    });
                    return;
                }

                const data = parsed.data;
                const idx = data.key;
                const task = data.task;
                const desc = data.desc;
                const deadline = data.deadline;

                const key = idx + "," + sender_id;
                const completed = data.completed;

                const task_data = {
                    task,
                    desc,
                    deadline,
                    idx,
                    key,
                    completed,
                    in_progress: false,
                };

                if (!this.name_in_use(task)) {
                    this.task_map.set(key, task_data);
                }

                // I may have added a task from another device.
                if (sender_id === this.me && this.my_idx <= idx) {
                    this.my_idx = idx + 1;
                }
            },
        },

        strike: {
            outbound(key: string): TaskStrikeOutboundData {
                const event = {
                    type: "strike" as const,
                    key,
                };

                return event;
            },

            inbound: (sender_id: number, raw_data: unknown): void => {
                const task_strike_inbound_data_schema = z.object({
                    type: z.literal("strike"),
                    key: z.string(),
                });
                const parsed = task_strike_inbound_data_schema.safeParse(raw_data);
                if (!parsed.success) {
                    blueslip.warn("todo widget: bad type for inbound strike key", {
                        error: parsed.error,
                    });
                    return;
                }
                // All message readers may strike/unstrike todo tasks.
                const data = parsed.data;
                const key = data.key;
                const item = this.task_map.get(key);

                if (item === undefined) {
                    blueslip.warn("Do we have legacy data? unknown key for tasks: " + key);
                    return;
                }

                // In a list with an assignee, only the author can
                // uncheck a task (the server enforces this too).
                if (item.completed && this.is_uncheck_restricted(sender_id)) {
                    return;
                }

                item.completed = !item.completed;
            },
        },

        edit_task: {
            outbound: (
                key: string,
                desc: string,
                deadline: string,
            ): TaskEditOutboundData | undefined => {
                const event = {
                    type: "edit_task" as const,
                    key,
                    desc,
                    deadline,
                };
                if (this.is_my_task_list()) {
                    return event;
                }
                return undefined;
            },

            inbound: (sender_id: number, raw_data: unknown): void => {
                const task_edit_inbound_data_schema = z.object({
                    type: z.literal("edit_task"),
                    key: z.string(),
                    desc: z.string(),
                    deadline: z.string(),
                });
                const parsed = task_edit_inbound_data_schema.safeParse(raw_data);
                if (!parsed.success) {
                    blueslip.warn("todo widget: bad type for inbound task edit", {
                        error: parsed.error,
                    });
                    return;
                }
                // Only the author of the list can edit a task's
                // description and deadline (the server enforces this too).
                if (sender_id !== this.message_sender_id) {
                    this.report_error_function(`user ${sender_id} is not allowed to edit tasks`);
                    return;
                }
                const data = parsed.data;
                const item = this.task_map.get(data.key);
                if (item === undefined) {
                    blueslip.warn("todo widget: unknown key for edited task: " + data.key);
                    return;
                }

                item.desc = data.desc;
                item.deadline = data.deadline;
            },
        },

        start_task: {
            outbound: (key: string): TaskStartOutboundData | undefined => {
                if (this.is_my_assignment()) {
                    return {type: "start_task" as const, key};
                }
                return undefined;
            },

            inbound: (sender_id: number, raw_data: unknown): void => {
                const parsed = this.parse_task_key_event("start_task", raw_data);
                if (parsed === undefined) {
                    return;
                }
                // Only the assignee can start a task (the server
                // enforces this too).
                if (sender_id !== this.assignee?.user_id) {
                    this.report_error_function(`user ${sender_id} is not allowed to start tasks`);
                    return;
                }
                const item = this.task_map.get(parsed.key);
                if (item !== undefined && !item.completed) {
                    item.in_progress = true;
                }
            },
        },

        reset_task: {
            outbound: (key: string): TaskResetOutboundData | undefined => {
                if (this.is_my_task_list()) {
                    return {type: "reset_task" as const, key};
                }
                return undefined;
            },

            inbound: (sender_id: number, raw_data: unknown): void => {
                const parsed = this.parse_task_key_event("reset_task", raw_data);
                if (parsed === undefined) {
                    return;
                }
                // Only the author of the list can take a task back to
                // pending (the server enforces this too).
                if (sender_id !== this.message_sender_id) {
                    this.report_error_function(`user ${sender_id} is not allowed to reset tasks`);
                    return;
                }
                const item = this.task_map.get(parsed.key);
                if (item !== undefined) {
                    item.completed = false;
                    item.in_progress = false;
                }
            },
        },
    };

    constructor({
        message_sender_id,
        task_list_title,
        tasks,
        assignee,
        report_error_function,
    }: {
        message_sender_id: number;
        task_list_title: string;
        tasks: TodoTask[];
        assignee?: TodoAssignee | null | undefined;
        report_error_function: (msg: string, more_info?: Record<string, unknown>) => void;
    }) {
        this.message_sender_id = message_sender_id;
        this.me = people.my_current_user_id();
        // input_mode indicates if the task list title is being input currently
        this.input_mode = this.is_my_task_list(); // for now
        this.report_error_function = report_error_function;
        this.assignee = assignee ?? undefined;
        this.task_list_title = "";
        if (task_list_title) {
            this.set_task_list_title(task_list_title);
        } else {
            this.set_task_list_title($t({defaultMessage: "Task list"}));
        }

        for (const [i, data] of tasks.entries()) {
            this.handle.new_task.inbound("canned", {
                key: i,
                task: data.task,
                desc: data.desc,
                deadline: data.deadline ?? "",
                completed: false,
            });
        }
    }

    is_my_task_list(): boolean {
        return people.is_my_user_id(this.message_sender_id);
    }

    parse_task_key_event(
        type: "start_task" | "reset_task",
        raw_data: unknown,
    ): {key: string} | undefined {
        const parsed = z.object({type: z.literal(type), key: z.string()}).safeParse(raw_data);
        if (!parsed.success) {
            blueslip.warn(`todo widget: bad type for inbound ${type}`, {error: parsed.error});
            return undefined;
        }
        return parsed.data;
    }

    is_my_assignment(): boolean {
        return this.assignee !== undefined && people.is_my_user_id(this.assignee.user_id);
    }

    has_assignee(): boolean {
        return this.assignee !== undefined;
    }

    get_task(key: string): Task | undefined {
        return this.task_map.get(key);
    }

    is_uncheck_restricted(user_id: number): boolean {
        return this.assignee !== undefined && user_id !== this.message_sender_id;
    }

    set_task_list_title(new_title: string): void {
        this.input_mode = false;
        this.task_list_title = new_title;
    }

    get_task_list_title(): string {
        return this.task_list_title;
    }

    get_assignee_name(): string | undefined {
        if (this.assignee === undefined) {
            return undefined;
        }
        return (
            people.maybe_get_user_by_id(this.assignee.user_id, true)?.full_name ??
            this.assignee.email
        );
    }

    set_input_mode(): void {
        this.input_mode = true;
    }

    clear_input_mode(): void {
        this.input_mode = false;
    }

    get_input_mode(): boolean {
        return this.input_mode;
    }

    get_widget_data(): {
        all_tasks: Task[];
    } {
        const all_tasks = [...this.task_map.values()];
        const now = Date.now();
        for (const item of all_tasks) {
            item.status_icon = item.completed
                ? "✅"
                : item.in_progress
                  ? "🔧"
                  : item.deadline && new Date(item.deadline).getTime() < now
                    ? "⚠️"
                    : "⏳";
            const must_start = this.has_assignee() && !item.completed && !item.in_progress;
            if (item.completed && this.is_uncheck_restricted(this.me)) {
                item.locked = true;
                item.lock_reason = $t({
                    defaultMessage: "Only the author of the list can uncheck this task.",
                });
            } else if (must_start) {
                item.locked = true;
                item.lock_reason = $t({
                    defaultMessage: "The task must be started before it can be checked off.",
                });
            } else {
                item.locked = false;
                item.lock_reason = undefined;
            }
            item.can_start = must_start && this.is_my_assignment();
            item.can_reset =
                this.has_assignee() &&
                this.is_my_task_list() &&
                (item.completed || item.in_progress);
        }

        const widget_data = {
            all_tasks,
        };

        return widget_data;
    }

    name_in_use(name: string): boolean {
        for (const item of this.task_map.values()) {
            if (item.task === name) {
                return true;
            }
        }

        return false;
    }

    handle_event(sender_id: number, raw_data: unknown): void {
        const parsed = todo_widget_inbound_data.safeParse(raw_data);
        if (!parsed.success) {
            return;
        }

        const {data} = parsed;
        const type = data.type;
        if (this.handle[type]) {
            this.handle[type].inbound(sender_id, data);
        } else {
            blueslip.warn(`todo widget: unknown inbound type: ${type}`);
        }
    }
}
