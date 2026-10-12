import json
import re
from dataclasses import asdict, dataclass
from typing import Any

from django.utils.translation import gettext as _

from zerver.lib.message import SendMessageRequest
from zerver.models import Message, Realm, SubMessage, UserProfile


@dataclass
class PollData:
    question: str
    options: list[str]


@dataclass
class TodoTaskData:
    task: str
    desc: str
    deadline: str = ""

@dataclass
class TodoData:
    task_list_title: str
    tasks: list[TodoTaskData]
     # {"user_id": ..., "email": ...} of the user the list is shared with, if an>
    assignee: dict[str, Any] | None = None

def get_widget_data(content: str) -> tuple[str | None, Any]:
    valid_widget_types = ["poll", "todo"]
    tokens = re.split(r"\s+|\n+", content)

    # tokens[0] will always exist
    if tokens[0].startswith("/"):
        widget_type = tokens[0].removeprefix("/")
        if widget_type in valid_widget_types:
            remaining_content = content.replace(tokens[0], "", 1)
            extra_data = get_extra_data_from_widget_type(remaining_content, widget_type)
            return widget_type, asdict(extra_data)

    return None, None


def parse_poll_extra_data(content: str) -> PollData:
    # This is used to extract the question from the poll command.
    # The command '/poll question' will pre-set the question in the poll
    lines = content.splitlines()
    question = ""
    options = []
    if lines and lines[0]:
        question = lines.pop(0).strip()
    for line in lines:
        # If someone is using the list syntax, we remove it
        # before adding an option.
        option = re.sub(r"(\s*[-*]?\s*)", "", line.strip(), count=1)
        if len(option) > 0:
            options.append(option)
    return PollData(question=question, options=options)


def parse_todo_extra_data(content: str) -> TodoData:
    # This is used to extract the task list title from the todo command.
    # The command '/todo Title' will pre-set the task list title
    lines = content.splitlines()
    task_list_title = ""
    if lines and lines[0]:
        task_list_title = lines.pop(0).strip()
    # An optional assignee follows the title, separated by "@@", as a user
    # id or email, e.g. "/todo Title @@ 42". It is resolved against the
    # realm in resolve_todo_assignee.
    assignee = None
    if "@@" in task_list_title:
        task_list_title, assignee_ref = task_list_title.split("@@", 1)
        task_list_title = task_list_title.strip()
        assignee_ref = assignee_ref.strip()
        if assignee_ref.isdigit():
            assignee = {"user_id": int(assignee_ref)}
        elif assignee_ref:
            assignee = {"email": assignee_ref}
    tasks = []
    for line in lines:
         # If someone is using the list syntax, we remove it
        # before adding a task.
        task_data = re.sub(r"(\s*[-*]?\s*)", "", line.strip(), count=1)
        if len(task_data) > 0:
            # an optional deadline is appended at the end of the line,
            # separated by ">>", e.g. "task: desc >> 2026-09-20"
            deadline = ""
            if ">>" in task_data:
                task_data, deadline = task_data.split(">>", 1)
                task_data = task_data.strip()
                deadline = deadline.strip()
            # a task and its description (optional) are separated
            # by the (first) `: ` substring
            task_data_array = task_data.split(": ", 1)
            tasks.append(
                TodoTaskData(
                    task=task_data_array[0].strip(),
                    desc=task_data_array[1].strip() if len(task_data_array) > 1 else "",
                    deadline=deadline,
                )
            )
    return TodoData(task_list_title=task_list_title, tasks=tasks)

def resolve_todo_assignee(realm: Realm, assignee: dict[str, Any]) -> dict[str, Any] | None:
    """Returns {"user_id", "email"} for the active, human user of the realm
    that `assignee` refers to (by "user_id", or else by "email"), or None if
    there is no such user. The email is always taken from the database."""
    users = UserProfile.objects.filter(realm=realm, is_active=True, is_bot=False)
    user_id = assignee.get("user_id")
    email = assignee.get("email")
    if isinstance(user_id, int):
        user = users.filter(id=user_id).first()
    elif isinstance(email, str) and email:
        user = users.filter(email__iexact=email).first()
    else:
        return None
    if user is None:
        return None
    return {"user_id": user.id, "email": user.email}

def get_extra_data_from_widget_type(content: str, widget_type: str | None) -> PollData | TodoData:
    if widget_type == "poll":
        return parse_poll_extra_data(content)
    else:
        return parse_todo_extra_data(content)


def do_widget_post_save_actions(send_request: SendMessageRequest) -> None:
    """
    This code works with the web app; mobile and other
    clients should also start supporting this soon.
    """
    message_content = send_request.message.content
    sender_id = send_request.message.sender_id
    message_id = send_request.message.id

    widget_type = None
    extra_data = None

    widget_type, extra_data = get_widget_data(message_content)
    widget_content = send_request.widget_content
    if widget_content is not None:
        # Note that we validate this data in check_message,
        # so we can trust it here.
        widget_type = widget_content["widget_type"]
        extra_data = widget_content["extra_data"]

    if widget_type:
        content = dict(
            widget_type=widget_type,
            extra_data=extra_data,
        )
        submessage = SubMessage(
            sender_id=sender_id,
            message_id=message_id,
            msg_type="widget",
            content=json.dumps(content),
        )
        submessage.save()
        send_request.submessages = SubMessage.get_raw_db_rows([message_id])


def get_widget_type(*, message_id: int) -> str | None:
    submessage = (
        SubMessage.objects.filter(
            message_id=message_id,
            msg_type="widget",
        )
        .only("content")
        .first()
    )

    if submessage is None:
        return None

    try:
        data = json.loads(submessage.content)
    except Exception:
        return None

    try:
        return data["widget_type"]
    except Exception:
        return None

def check_todo_assignee_recipients(
    content: str, realm: Realm, sender: UserProfile, dm_recipient_ids: set[int] | None
) -> None:
    """A to-do list with an assignee is shared only with that user: it
    must be sent as a direct message between the sender and the assignee.
    `dm_recipient_ids` is None for channel messages."""
    widget_type, extra_data = get_widget_data(content)
    if widget_type != "todo" or extra_data["assignee"] is None:
        return
    assignee = resolve_todo_assignee(realm, extra_data["assignee"])
    if assignee is None:
        raise JsonableError(_("Invalid assignee for the to-do list."))
    if dm_recipient_ids is None or dm_recipient_ids | {sender.id} != {
        sender.id,
        assignee["user_id"],
    }:
        raise JsonableError(
            _("A to-do list with an assignee must be a direct message to the assignee.")
        )



def is_widget_message(message: Message) -> bool:
    # Right now all messages that are widgetized use submessage, and vice versa.
    return message.submessage_set.exists()
