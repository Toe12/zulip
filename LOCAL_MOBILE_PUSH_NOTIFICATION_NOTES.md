# Local mobile push notification debugging notes

This note records the local changes and commands used while debugging Android
emulator push notifications against the Zulip development server.

## Current local source status

### Zulip server repository

The temporary backend change that remapped mobile push payload URLs to
`http://localhost:8080/web` has been reverted.

Specifically, `zerver/lib/push_notifications.py` is back to using the realm URL
directly in `realm_uri` and `realm_url`.

The following local source changes are still present in this working tree, but
they were not part of the reverted payload-remap change:

- `zproject/dev_settings.py`
  - `EXTERNAL_HOST` is set to `localhost:9991`.
- `zproject/default_settings.py`
  - `DEVELOPMENT_DISABLE_PUSH_BOUNCER_DOMAIN_CHECK` is set to `True`.
  - `ANDROID_FCM_CREDENTIALS_PATH` points at
    `/srv/zulip/zproject/firebase-credentials.json`.
- `zproject/prod_settings_template.py`
  - `ZULIP_SERVICE_SUBMIT_USAGE_STATISTICS = False` is uncommented.
- `zerver/actions/create_user.py` and `zerver/tests/test_new_users.py`
  - These contain separate training-notifier-bot changes.

### Zulip Flutter repository

The Flutter app still has the local E2EE bouncer key experiment applied:

```dart
static final bouncerPublicKey = base64Decode('pbPeCPVC2rk+VlgRnqgwbuVeTSxFLNcHOY09ossq5Fw='); // local dev bouncer key
```

The upstream value was:

```dart
static final bouncerPublicKey = base64Decode('mm4F/3WLqECY637NulC5j/ZeHkmpwmtlfIxwt8MfREM='); // generated 2026-02-24
```

That line is in:

```text
/Users/toearkar/coding_project/wecare/zulip-flutter/lib/model/push_device.dart
```

## Backend URL remap change that was reverted

The reverted experiment changed mobile push payload generation so that the app
would receive:

```text
http://localhost:8080/web
```

instead of:

```text
http://localhost:9991
```

The reverted implementation had two parts:

1. `zproject/dev_settings.py`

   ```python
   REALM_MOBILE_REMAP_URIS = {
       "http://localhost:9991": "http://localhost:8080/web",
   }
   ```

2. `zerver/lib/push_notifications.py`

   ```python
   realm_uri = settings.REALM_MOBILE_REMAP_URIS.get(
       user_profile.realm.url,
       user_profile.realm.url,
   )
   ```

   The push payload then used `realm_uri` for both `realm_uri` and `realm_url`.

This was verified with a Django shell payload check, then reverted when the app
stopped working as expected.

## E2EE push registration finding

The Flutter Android app ignored legacy plaintext push payloads for newer server
feature levels. The relevant client behavior was in:

```text
/Users/toearkar/coding_project/wecare/zulip-flutter/lib/notifications/receive.dart
```

The local device registration in the server database had:

```text
push_registration_error_code = INVALID_BOUNCER_PUBLIC_KEY
```

The server-side local bouncer public key was read from:

```text
/srv/zulip/zproject/dev-secrets.conf
```

under:

```text
push_registration_encryption_keys
```

The public key used for the local experiment was:

```text
pbPeCPVC2rk+VlgRnqgwbuVeTSxFLNcHOY09ossq5Fw=
```

Only the public key should be copied into Flutter. Do not copy or commit the
matching private key.

## Local bouncer and realm database changes

To make the local development bouncer allow push notifications for
`localhost:9991`, the local bouncer database was adjusted so the remote realm
for `localhost:9991` used the community plan.

The local realm push flag was also set to enabled.

These were database-only changes, not source-file changes.

Useful Django shell checks:

```bash
./tools/shell
```

Inside the shell:

```python
from zerver.models import Realm

[(realm.string_id, realm.url, realm.push_notifications_enabled) for realm in Realm.objects.all()]
```

For bouncer status, inspect the relevant `RemoteRealm` and the result of
`get_push_status_for_remote_request` in the development shell.

## Android emulator notification commands

Use these from the host machine when the Android emulator is running.

List devices:

```bash
adb devices
```

Grant Android notification permission:

```bash
adb shell pm grant com.zulipmobile android.permission.POST_NOTIFICATIONS
```

Check whether notifications are enabled for the app:

```bash
adb shell cmd notification get_package_importance com.zulipmobile
```

Clear app notification state:

```bash
adb shell cmd notification reset_assistant_user_set com.zulipmobile
```

Open Android app notification settings:

```bash
adb shell am start -a android.settings.APP_NOTIFICATION_SETTINGS --es package com.zulipmobile
```

Watch notification-related logs:

```bash
adb logcat | rg -i "zulip|firebase|fcm|notification|push"
```

Watch app logs only, if the package process is running:

```bash
adb logcat --pid "$(adb shell pidof -s com.zulipmobile)"
```

## Backend commands used during debugging

Run Django shell inside the Zulip development environment:

```bash
vagrant ssh -c "cd /srv/zulip && ./tools/shell"
```

Run focused push notification tests:

```bash
./tools/test-backend zerver.tests.test_push_notifications
```

Check source diffs:

```bash
git diff -- zerver/lib/push_notifications.py zproject/dev_settings.py
git diff -- zproject/default_settings.py zproject/prod_settings_template.py
```

Check Flutter diff:

```bash
git -C /Users/toearkar/coding_project/wecare/zulip-flutter diff -- lib/model/push_device.dart
```

## Test results from the debugging session

The payload-remap change was manually verified in a Django shell before being
reverted.

The broader push notification test run had local-environment failures related
to configured Firebase credentials and existing local settings. Those failures
were not clean evidence that the payload-remap code itself was broken.

No final test run was done after the revert.

