from argparse import ArgumentParser
from datetime import date
from typing import Any

from typing_extensions import override

from zerver.lib.management import ZulipBaseCommand
from zerver.lib.send_email import FromAddress, send_email
from zerver.lib.todo_reminders import get_todo_reminders


class Command(ZulipBaseCommand):
    help = """Emails each assignee of a to-do list a reminder of their pending
tasks whose deadline hasn't passed yet (due today and upcoming). Meant to
run once a day from cron."""

    @override
    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print the emails instead of sending them.",
        )
        parser.add_argument(
            "--user-id",
            type=int,
            action="append",
            dest="user_ids",
            help="Only remind this user (can be repeated).",
        )
        parser.add_argument(
            "--date",
            type=date.fromisoformat,
            help="Pretend today is this date (YYYY-MM-DD), for testing.",
        )

    @override
    def handle(self, *args: Any, **options: Any) -> None:
        user_ids = set(options["user_ids"]) if options["user_ids"] else None
        reminders = get_todo_reminders(user_ids=user_ids, today=options["date"])
        for user, groups in reminders:
            send_email(
                "zerver/emails/todo_reminder",
                to_user_ids=[user.id],
                from_address=FromAddress.tokenized_no_reply_placeholder,
                realm=user.realm,
                context={
                    "full_name": user.full_name,
                    "realm_name": user.realm.name,
                    "realm_url": user.realm.url,
                    "due_today": groups["today"],
                    "upcoming": groups["upcoming"],
                    "task_count": sum(len(tasks) for tasks in groups.values()),
                },
                dry_run=options["dry_run"],
            )
        print(
            f"{'Would send' if options['dry_run'] else 'Sent'} {len(reminders)} to-do reminder email(s)."
        )