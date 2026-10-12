import $ from "jquery";
import SortableJS from "sortablejs";

import render_poll_modal_option from "../templates/poll_modal_option.hbs";
import render_todo_modal_task from "../templates/todo_modal_task.hbs";

import * as todo_assignee_pill from "./todo_assignee_pill.ts";
import type {TodoAssignee} from "./todo_assignee_pill.ts";
import type {UserPillWidget} from "./user_pill.ts";
import * as util from "./util.ts";

// Picker for the (single) user the to-do list is shared with.
let todo_assignee_pills: UserPillWidget | undefined;

function create_option_row(
    $last_option_row_input: JQuery,
    template: (context?: unknown) => string,
): void {
    const row_html = template();
    const $row_container = $last_option_row_input.closest(".simplebar-content");
    $row_container.append($(row_html));
}

function add_option_row(this: HTMLElement, widget_type: string): void {
    // if the option triggering the input event e is not the last,
    // that is, its next sibling has the class `option-row`, we
    // do not add a new option row and return from this function
    // This handles a case when the next empty input row is already
    // added and user is updating the above row(s).
    if ($(this).closest(".option-row").next().hasClass("option-row")) {
        return;
    }
    const template = widget_type === "POLL" ? render_poll_modal_option : render_todo_modal_task;
    create_option_row($(this), template);
}

function delete_option_row(this: HTMLElement): void {
    const $row = $(this).closest(".option-row");
    $row.remove();
}

function setup_sortable_list(selector: string): void {
    // setTimeout is needed to here to give time for simplebar to initialise
    setTimeout(() => {
        SortableJS.create(util.the($($(selector + " .simplebar-content"))), {
            onUpdate() {
                // Do nothing on drag; the order is only processed on submission.
            },
            // We don't want the last (empty) row to be draggable, as a new row
            // is added on input event of the last row.
            filter: "input, .option-row:last-child",
            preventOnFilter: false,
        });
    }, 0);
}

export function poll_options_setup(): void {
    const $poll_options_list = $("#add-poll-form .poll-options-list");
    const $submit_button = $("#add-poll-modal .dialog_submit_button");
    const $question_input = $<HTMLInputElement>("#add-poll-form input#poll-question-input");

    // Disable the submit button if the question is empty.
    $submit_button.prop("disabled", true);
    $question_input.on("input", () => {
        if ($question_input.val()!.trim() !== "") {
            $submit_button.prop("disabled", false);
        } else {
            $submit_button.prop("disabled", true);
        }
    });

    $poll_options_list.on("input", "input.poll-option-input", function (this: HTMLElement) {
        add_option_row.call(this, "POLL");
    });
    $poll_options_list.on("click", "button.delete-option", delete_option_row);

    setup_sortable_list("#add-poll-form .poll-options-list");
}

export function todo_list_tasks_setup(): void {
    const $todo_options_list = $("#add-todo-form .todo-options-list");
    $todo_options_list.on("input", "input.todo-input", function (this: HTMLElement) {
        add_option_row.call(this, "TODO");
    });
    $todo_options_list.on("click", "button.delete-option", delete_option_row);
    todo_assignee_pills = todo_assignee_pill.create($("#add-todo-form .todo-assignee-picker"));

    setup_sortable_list("#add-todo-form .todo-options-list");
}

export function frame_poll_message_content(): string {
    const question = $<HTMLInputElement>("input#poll-question-input").val()!.trim();
    const options = $<HTMLInputElement>("input.poll-option-input")
        .map(function () {
            return $(this).val()!.trim();
        })
        .toArray()
        .filter(Boolean);
    return "/poll " + question + "\n" + options.join("\n");
}

export function get_todo_list_assignee(): TodoAssignee | undefined {
    if (todo_assignee_pills === undefined) {
        return undefined;
    }
    return todo_assignee_pill.get_assignee(todo_assignee_pills);
}

export function frame_todo_message_content(): string {
    let title = $<HTMLInputElement>("input#todo-title-input").val()?.trim().replaceAll("@@", "");

    if (title === "") {
        title = "Task list";
    }
    // The assignee follows the title, as "@@ <user_id>"; the server
    // resolves it to the user's id and email.
    const assignee = get_todo_list_assignee();
    const todo_str =
        assignee === undefined ? `/todo ${title}\n` : `/todo ${title} @@ ${assignee.user_id}\n`;

    const todos: string[] = [];

    $(".option-row").each(function () {
        const todo_name =
            $(this).find<HTMLInputElement>("input.todo-input").val()?.trim().replaceAll(">>", "") ??
            "";
        const todo_description =
            $(this)
                .find<HTMLInputElement>("input.todo-description-input")
                .val()
                ?.trim()
                .replaceAll(">>", "") ?? "";
        const todo_deadline =
            $(this).find<HTMLInputElement>("input.todo-deadline-input").val()?.trim() ?? "";

        if (todo_name) {
            let todo = todo_description ? `${todo_name}: ${todo_description}` : todo_name;
            if (todo_deadline) {
                todo += ` >> ${todo_deadline}`;
            }
            todos.push(todo);
        }
    });

    return todo_str + todos.join("\n");
}
