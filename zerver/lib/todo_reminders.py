import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.utils.translation import gettext as _

from zerver.lib.exceptions import JsonableError
from zerver.models import Message, Recipient, SubMessage, UserProfile

# Used for users who haven't set a timezone in their Zulip settings.
DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires"


@dataclass
class TodoTaskState:
    task: str
    desc: str
    deadline: str
    completed: bool = False
    # Set by the assignee ("start_task"); a task must be started
    # before it can be checked off.
    in_progress: bool = False


@dataclass
class TodoListState:
    message_id: int
    title: str
    assignee_id: int
    tasks: dict[str, TodoTaskState] = field(default_factory=dict)


def build_todo_list_state(
    message_id: int, message_sender_id: int, submessages: list[SubMessage]
) -> TodoListState | None:
    """Replays a todo widget's submessages, the same way the web client
    (web/src/todo_data.ts) does, to get the list's current state.
    Returns None for lists without an assignee."""
    try:
        widget = json.loads(submessages[0].content)
    except (json.JSONDecodeError, IndexError):
        return None
    if not isinstance(widget, dict) or widget.get("widget_type") != "todo":
        return None
    extra_data = widget.get("extra_data") or {}
    assignee = extra_data.get("assignee")
    if not isinstance(assignee, dict) or not isinstance(assignee.get("user_id"), int):
        return None

    state = TodoListState(
        message_id=message_id,
        title=extra_data.get("task_list_title") or "Task list",
        assignee_id=assignee["user_id"],
    )

    def add_task(key: str, data: dict[str, Any]) -> None:
        name = data.get("task")
        if not isinstance(name, str) or any(t.task == name for t in state.tasks.values()):
            return
        state.tasks[key] = TodoTaskState(
            task=name,
            desc=data.get("desc") or "",
            deadline=data.get("deadline") or "",
            completed=bool(data.get("completed", False)),
        )

    for i, task in enumerate(extra_data.get("tasks") or []):
        if isinstance(task, dict):
            add_task(f"{i},canned", {**task, "completed": False})

    for submessage in submessages[1:]:
        try:
            event = json.loads(submessage.content)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "new_task":
            add_task(f"{event.get('key')},{submessage.sender_id}", event)
        elif event.get("type") == "strike":
            item = state.tasks.get(str(event.get("key")))
            # Once checked off, only the author of the list can uncheck a task.
            # (That a task must be started first is only checked when the
            # event is sent, so that tasks checked off before that rule
            # existed stay checked off.)
            if item is not None and not (
                item.completed and submessage.sender_id != message_sender_id
            ):
                item.completed = not item.completed
        elif event.get("type") == "start_task" and submessage.sender_id == state.assignee_id:
            # Only the assignee can start a pending task.
            item = state.tasks.get(str(event.get("key")))
            if item is not None and not item.completed:
                item.in_progress = True
        elif event.get("type") == "reset_task" and submessage.sender_id == message_sender_id:
            # Only the author of the list can take a task back to pending.
            item = state.tasks.get(str(event.get("key")))
            if item is not None:
                item.completed = False
                item.in_progress = False
        elif event.get("type") == "edit_task" and submessage.sender_id == message_sender_id:
            # Only the author of the list can edit a task's description and deadline.
            item = state.tasks.get(str(event.get("key")))
            if item is not None:
                if isinstance(event.get("desc"), str):
                    item.desc = event["desc"]
                if isinstance(event.get("deadline"), str):
                    item.deadline = event["deadline"]
        elif (
            event.get("type") == "new_task_list_title"
            # Only the author of the list can change its title.
            and submessage.sender_id == message_sender_id
            and isinstance(event.get("title"), str)
        ):
            state.title = event["title"]
    return state


def check_assigned_todo_list_event(message: Message, sender_id: int, event: dict[str, Any]) -> None:
    """Enforces the rules of to-do lists with an assignee on a widget
    event, before it's saved (validate_todo_data has checked its shape):
    no new tasks; only the author edits, unchecks or resets a task; only
    the assignee starts one; and a task must be started to be checked off."""
    submessages = list(
        SubMessage.objects.filter(message_id=message.id, msg_type="widget").order_by("id")
    )
    state = build_todo_list_state(message.id, message.sender_id, submessages)
    event_type = event["type"]
    if state is None:
        if event_type in ("edit_task", "start_task", "reset_task"):
            raise JsonableError(_("This is only possible in a to-do list with an assignee."))
        return

    if event_type == "new_task":
        raise JsonableError(_("Tasks can't be added to a to-do list with an assignee."))
    if event_type not in ("strike", "edit_task", "start_task", "reset_task"):
        return

    item = state.tasks.get(event["key"])
    if item is None:
        raise JsonableError(_("Unknown task."))
    is_author = sender_id == message.sender_id
    if event_type == "strike":
        if item.completed and not is_author:
            raise JsonableError(_("Only the author of the to-do list can uncheck a task."))
        if not item.completed and not item.in_progress:
            raise JsonableError(_("A task must be started before it can be checked off."))
    elif event_type == "start_task":
        if sender_id != state.assignee_id:
            raise JsonableError(_("Only the assignee can start a task."))
        if item.completed or item.in_progress:
            raise JsonableError(_("This task has already been started."))


def get_assigned_todo_lists() -> list[TodoListState]:
    """All todo lists with an assignee, as direct messages."""
    widget_submessages = (
        SubMessage.objects.filter(
            msg_type="widget",
            content__startswith='{"widget_type": "todo"',
            content__contains='"assignee": {',
        )
        .exclude(message__recipient__type=Recipient.STREAM)
        .select_related("message")
    )
    senders = {sm.message_id: sm.message.sender_id for sm in widget_submessages}

    submessages_by_message: dict[int, list[SubMessage]] = defaultdict(list)
    for submessage in SubMessage.objects.filter(
        message_id__in=list(senders), msg_type="widget"
    ).order_by("id"):
        submessages_by_message[submessage.message_id].append(submessage)

    lists = []
    for message_id, sender_id in senders.items():
        state = build_todo_list_state(message_id, sender_id, submessages_by_message[message_id])
        if state is not None:
            lists.append(state)
    return lists


def get_user_today(user: UserProfile) -> date:
    try:
        tz = ZoneInfo(user.timezone or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo(DEFAULT_TIMEZONE)
    return datetime.now(tz).date()


def get_todo_reminders(
    user_ids: set[int] | None = None, today: date | None = None
) -> list[tuple[UserProfile, dict[str, list[dict[str, str]]]]]:
    """For each assignee (active, human) with pending tasks whose deadline
    hasn't passed, returns those tasks split into due today and upcoming,
    each sorted by deadline."""
    lists_by_assignee: dict[int, list[TodoListState]] = defaultdict(list)
    for todo_list in get_assigned_todo_lists():
        if user_ids is None or todo_list.assignee_id in user_ids:
            lists_by_assignee[todo_list.assignee_id].append(todo_list)

    users = UserProfile.objects.filter(
        id__in=list(lists_by_assignee), is_active=True, is_bot=False
    ).select_related("realm")

    reminders = []
    for user in users:
        user_today = today or get_user_today(user)
        groups: dict[str, list[dict[str, str]]] = {"today": [], "upcoming": []}
        for todo_list in lists_by_assignee[user.id]:
            for task in todo_list.tasks.values():
                if task.completed or not task.deadline:
                    continue
                try:
                    deadline = date.fromisoformat(task.deadline)
                except ValueError:
                    continue
                # Reminders are sent every day until the task's deadline.
                if deadline < user_today:
                    continue
                group = "today" if deadline == user_today else "upcoming"
                groups[group].append(
                    {
                        "task": task.task,
                        "desc": task.desc,
                        "deadline": deadline.isoformat(),
                        "status": "in_progress" if task.in_progress else "not_started",
                        "list_title": todo_list.title,
                        "url": f"{user.realm.url}/#narrow/id/{todo_list.message_id}",
                    }
                )
        if any(groups.values()):
            for tasks in groups.values():
                tasks.sort(key=lambda t: t["deadline"])
            reminders.append((user, groups))
    return reminders
