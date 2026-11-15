from datetime import timedelta

from zerver.actions.streams import do_change_stream_group_based_setting
from zerver.actions.user_groups import check_add_user_group
from zerver.lib.message import has_message_access
from zerver.lib.narrow import NarrowParameter, ok_to_include_history
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.user_groups import UserGroupMembershipDetails
from zerver.models import Message, Stream, UserMessage, UserProfile
from zerver.models.realms import get_realm


class ChannelAdminVisibilityTest(ZulipTestCase):
    """Tests for the custom visibility policy, under which an ordinary user
    only reads the channel messages they have a UserMessage row for, while
    organization administrators and the channel's own administrators
    (can_administer_channel_group) read every message in the channel.
    """

    def setUp(self) -> None:
        super().setUp()
        self.realm = get_realm("zulip")
        # cordelia sends; othello administers the channel; hamlet is an
        # ordinary member with no permissions; iago is an organization
        # administrator.
        self.sender = self.example_user("cordelia")
        self.channel_admin = self.example_user("othello")
        self.member = self.example_user("hamlet")
        self.realm_admin = self.example_user("iago")
        self.assertTrue(self.realm_admin.is_realm_admin)
        self.assertFalse(self.channel_admin.is_realm_admin)
        self.assertFalse(self.member.is_realm_admin)

    def make_channel_with_admin(
        self,
        channel_name: str,
        admin: UserProfile | None = None,
        *,
        invite_only: bool = False,
        history_public_to_subscribers: bool | None = None,
    ) -> Stream:
        channel = self.make_stream(
            channel_name,
            invite_only=invite_only,
            history_public_to_subscribers=history_public_to_subscribers,
        )
        for user in (self.sender, self.channel_admin, self.member, self.realm_admin):
            self.subscribe(user, channel_name)
        if admin is not None:
            admin_group = check_add_user_group(
                self.realm, f"{channel_name}-admins", [admin], acting_user=admin
            )
            do_change_stream_group_based_setting(
                channel,
                "can_administer_channel_group",
                admin_group,
                acting_user=self.realm_admin,
            )
        return channel

    def assert_has_user_message(
        self, user_profile: UserProfile, message_id: int, expected: bool
    ) -> None:
        self.assertEqual(
            UserMessage.objects.filter(
                user_profile=user_profile, message_id=message_id
            ).exists(),
            expected,
        )

    def test_channel_administrator_receives_other_users_messages(self) -> None:
        self.make_channel_with_admin("claims", admin=self.channel_admin)

        message_id = self.send_stream_message(self.sender, "claims", "secret")

        # The sender always keeps their own message.
        self.assert_has_user_message(self.sender, message_id, True)
        # Organization and channel administrators read everything here.
        self.assert_has_user_message(self.realm_admin, message_id, True)
        self.assert_has_user_message(self.channel_admin, message_id, True)
        # An ordinary member does not.
        self.assert_has_user_message(self.member, message_id, False)

    def test_channel_administrator_privilege_is_scoped_to_their_channel(self) -> None:
        self.make_channel_with_admin("claims", admin=self.channel_admin)
        self.make_channel_with_admin("payroll", admin=None)

        message_id = self.send_stream_message(self.sender, "payroll", "secret")

        # othello administers "claims", not "payroll", so here he is an
        # ordinary member.
        self.assert_has_user_message(self.channel_admin, message_id, False)
        self.assert_has_user_message(self.realm_admin, message_id, True)

    def test_guest_channel_administrator_is_not_privileged(self) -> None:
        # can_administer_channel_group has allow_everyone_group=False, so a
        # guest in that group never gains this access.
        guest = self.example_user("polonius")
        self.assertTrue(guest.is_guest)
        self.make_channel_with_admin("claims", admin=guest)
        self.subscribe(guest, "claims")

        message_id = self.send_stream_message(self.sender, "claims", "secret")

        self.assert_has_user_message(guest, message_id, False)

    def test_channel_administrator_can_access_message_without_user_message(self) -> None:
        channel = self.make_channel_with_admin("claims", admin=self.channel_admin)
        message_id = self.send_stream_message(self.sender, "claims", "secret")
        message = Message.objects.get(id=message_id)

        # Deleting the row models a user promoted to channel administrator
        # after the message was sent, who therefore never received one.
        UserMessage.objects.filter(
            user_profile=self.channel_admin, message_id=message_id
        ).delete()

        self.assertTrue(
            has_message_access(
                self.channel_admin,
                message,
                has_user_message=lambda: False,
                stream=channel,
                is_subscribed=True,
                user_group_membership_details=UserGroupMembershipDetails(
                    user_recursive_group_ids=None
                ),
                is_modifying_message=False,
            )
        )
        self.assertFalse(
            has_message_access(
                self.member,
                message,
                has_user_message=lambda: False,
                stream=channel,
                is_subscribed=True,
                user_group_membership_details=UserGroupMembershipDetails(
                    user_recursive_group_ids=None
                ),
                is_modifying_message=False,
            )
        )

    def test_channel_administrator_reads_history_from_before_they_joined(self) -> None:
        channel = self.make_channel_with_admin("claims", admin=self.channel_admin)
        message_id = self.send_stream_message(self.sender, "claims", "secret")
        message = Message.objects.get(id=message_id)

        # The date_joined cutoff must not apply to users who read the whole
        # channel, and must still apply to everyone else.
        for user in (self.channel_admin, self.member):
            user.date_joined = message.date_sent + timedelta(days=1)
            user.save(update_fields=["date_joined"])

        def access(user_profile: UserProfile) -> bool:
            return has_message_access(
                user_profile,
                message,
                has_user_message=lambda: True,
                stream=channel,
                is_subscribed=True,
                user_group_membership_details=UserGroupMembershipDetails(
                    user_recursive_group_ids=None
                ),
                is_modifying_message=False,
            )

        self.assertTrue(access(self.channel_admin))
        self.assertFalse(access(self.member))

    def test_member_cannot_fetch_an_undelivered_message_by_id(self) -> None:
        self.make_channel_with_admin("claims", admin=self.channel_admin)
        message_id = self.send_stream_message(self.sender, "claims", "secret")

        # The restriction has to hold for single-message access, not only
        # in the message list: otherwise the message is merely hidden, and
        # can still be read by walking message ids.
        self.assert_has_user_message(self.member, message_id, False)
        self.login_user(self.member)
        self.assert_json_error(
            self.client_get(f"/json/messages/{message_id}"), "Invalid message(s)"
        )

        # The people it was delivered to are unaffected.
        self.login_user(self.channel_admin)
        self.assert_json_success(self.client_get(f"/json/messages/{message_id}"))
        self.login_user(self.sender)
        self.assert_json_success(self.client_get(f"/json/messages/{message_id}"))

    def test_member_cannot_fetch_undelivered_message_with_public_history(self) -> None:
        # A private channel whose history is public to subscribers used to
        # grant every subscriber access to every message in it.
        self.make_channel_with_admin(
            "payroll",
            admin=self.channel_admin,
            invite_only=True,
            history_public_to_subscribers=True,
        )
        message_id = self.send_stream_message(self.sender, "payroll", "secret")

        self.assert_has_user_message(self.member, message_id, False)
        self.login_user(self.member)
        self.assert_json_error(
            self.client_get(f"/json/messages/{message_id}"), "Invalid message(s)"
        )

        self.login_user(self.channel_admin)
        self.assert_json_success(self.client_get(f"/json/messages/{message_id}"))

    def test_member_cannot_react_to_an_undelivered_message(self) -> None:
        # Reactions go through the same access check, so they must not be
        # a way to confirm a message exists either.
        self.make_channel_with_admin("claims", admin=self.channel_admin)
        message_id = self.send_stream_message(self.sender, "claims", "secret")

        self.login_user(self.member)
        result = self.client_post(
            f"/json/messages/{message_id}/reactions", {"emoji_name": "tada"}
        )
        self.assert_json_error(result, "Invalid message(s)")

    def test_channel_administrator_search_includes_history(self) -> None:
        self.make_channel_with_admin("claims", admin=self.channel_admin)
        self.send_stream_message(self.sender, "claims", "secret")

        # ok_to_include_history lets a user search messages they have no
        # UserMessage row for, so it must be true exactly for the users who
        # read the whole channel.
        narrow = [NarrowParameter(operator="channel", operand="claims")]
        self.assertTrue(
            ok_to_include_history(narrow, self.channel_admin, is_web_public_query=False)
        )
        self.assertTrue(
            ok_to_include_history(narrow, self.realm_admin, is_web_public_query=False)
        )
        self.assertFalse(
            ok_to_include_history(narrow, self.member, is_web_public_query=False)
        )
