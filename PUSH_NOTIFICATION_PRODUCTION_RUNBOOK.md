# Production Push Notifications — Complete Documentation (Self-Bouncing + E2EE)

Goal: mobile push notifications on the production Zulip server, with the server
acting as **its own push bouncer** — using your own Firebase + APNs and a custom
`zulip-flutter` build over **E2EE push**. No dependency on `push.zulipchat.com`.

- Server host: `zulip-appcheck`
- Domain / `EXTERNAL_HOST`: `basecomms.com`
- Realms: `basecomms.com` (root, empty string_id) and `zulipinternal.basecomms.com`
  (realm "Polaris", id=2)
- Deploy root: `/home/zulip/deployments/current` (code `12.0-beta1`)

All server commands run as **root** on the production server and wrap
`su zulip -c '…'` to execute as the `zulip` user.

---

## 1. Architecture

```
[ Custom Flutter app (release build) ]
  - bouncerPublicKey = your PRODUCTION E2EE public key
  - google-services.json = YOUR Firebase project
  - server URL = https://zulipinternal.basecomms.com
        | E2EE register: POST /mobile_push/register
        | (encrypts FCM token to bouncerPublicKey)
        v
[ Homeserver + Bouncer = SAME server (basecomms.com) ]
  - zilencer enabled -> this server IS the bouncer
  - ZULIP_SERVICES_URL = https://basecomms.com
  - ANDROID_FCM_CREDENTIALS_PATH = /etc/zulip/firebase-credentials.json
  - push_registration_encryption_keys (public+private) in zulip-secrets.conf
        | bouncer decrypts with PRIVATE key, sends via FCM
        v
[ FCM (your Firebase project) -> phone ]
```

Three things MUST match or push fails:

| App side | Server side |
|---|---|
| `bouncerPublicKey` | the **public** half of `push_registration_encryption_keys` |
| `google-services.json` Firebase project | `/etc/zulip/firebase-credentials.json` Firebase project |
| server URL the app targets | `basecomms.com` / `zulipinternal.basecomms.com` |

---

## 2. Current status (what is DONE)

1. ✅ Diagnosed: server was on `push.zulipchat.com`; custom app failed with
   `INVALID_BOUNCER_PUBLIC_KEY`. Chose to self-bounce.
2. ✅ `/etc/zulip/settings.py`: `ZULIP_SERVICES_URL="https://basecomms.com"`,
   `EXTRA_INSTALLED_APPS=["analytics","zilencer","corporate"]`,
   `ZULIP_SERVICE_PUSH_NOTIFICATIONS=True`.
3. ✅ Fixed `zproject/prod_settings.py` (was a stale copy, not a symlink to
   `/etc/zulip/settings.py`). `ZILENCER_ENABLED` now `True`.
4. ✅ Ran `migrate` after enabling zilencer -> zilencer tables created.
5. ✅ Generated the production E2EE bouncer keypair (stored in
   `/etc/zulip/zulip-secrets.conf`).
6. ✅ `register_server` succeeded — proven by the bouncer authenticating the server
   as `zulip-server:<uuid>` in the logs.

**Remaining:** rebuild the app with the correct public key + Firebase, install, let
it register over E2EE, then test. (Section 6–8.)

---

## 3. View / print the E2EE keypair

Stored as JSON in `/etc/zulip/zulip-secrets.conf`; **key = public, value = private**.

```bash
# Direct from secrets file (as root)
grep push_registration_encryption_keys /etc/zulip/zulip-secrets.conf
# -> push_registration_encryption_keys = {"PUBLIC_KEY": "PRIVATE_KEY"}
```
```bash
# Via Django (prints "public private" per pair)
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from django.conf import settings; [print(k, v) for k,v in settings.PUSH_REGISTRATION_ENCRYPTION_KEYS.items()]"'
```

- **PUBLIC key** -> goes into the app's `bouncerPublicKey`. Safe to share.
- **PRIVATE key** -> stays only in `zulip-secrets.conf`. Never put in the app or git.

Regenerate a keypair (writes to secrets, prints both):
```bash
su zulip -c '/home/zulip/deployments/current/manage.py manage_push_registration_encryption_keys --add'
su zulip -c '/home/zulip/deployments/current/scripts/restart-server'
```

---

## 4. Server-side setup (reference — already done)

```bash
# /etc/zulip/settings.py contains:
#   ZULIP_SERVICE_PUSH_NOTIFICATIONS = True
#   ZULIP_SERVICES_URL = "https://basecomms.com"
#   EXTRA_INSTALLED_APPS = ["analytics", "zilencer", "corporate"]
# and zproject/prod_settings.py is a symlink to /etc/zulip/settings.py

su zulip -c '/home/zulip/deployments/current/manage.py migrate'
su zulip -c '/home/zulip/deployments/current/manage.py register_server'

# create RemoteRealm rows via a bouncer sync:
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zerver.lib.remote_server import send_server_data_to_push_bouncer; send_server_data_to_push_bouncer(consider_usage_statistics=False, raise_on_error=True); print(\"sync OK\")"'

# grant free community plan:
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zilencer.models import RemoteRealm; from zerver.models import Realm; [RemoteRealm.objects.filter(uuid=r.uuid).update(plan_type=RemoteRealm.PLAN_TYPE_COMMUNITY) for r in Realm.objects.all()]; print(\"plan set\")"'

# sync again, then confirm:
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zerver.lib.remote_server import send_server_data_to_push_bouncer; send_server_data_to_push_bouncer(consider_usage_statistics=False, raise_on_error=True)"'
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zerver.models import Realm; [print(r.string_id, r.push_notifications_enabled) for r in Realm.objects.all()]"'
```
Server side is complete when both realms show `push_notifications_enabled = True`.

---

## 5. Why E2EE cannot be done by curl (and legacy is a dead end)

- **Legacy path** (`POST /users/me/android_gcm_reg_id`) writes a plaintext token to
  `PushDeviceToken`. Two problems for us:
  1. The custom app **ignores legacy plaintext pushes** (`receive.dart`) -> no banner.
  2. Tokens registered on the homeserver must also be registered *with the bouncer*;
     otherwise the bouncer returns `INVALID_REMOTE_PUSH_DEVICE_TOKEN`.
- **E2EE path** (`POST /mobile_push/register`) is **app-driven by design**: the app
  generates an account keypair, gets an FCM token, encrypts it to `bouncerPublicKey`,
  and registers -> creates a `Device` row. There is no curl shortcut; the crypto must
  happen in the app.

Conclusion: the only way to get a working, visible notification is the **app rebuild**.

---

## 6. Rebuild the custom app (`wecare/zulip-flutter`)

1. Set `bouncerPublicKey` in `lib/model/push_device.dart` to the **PUBLIC key** from
   Section 3 (replace the dev key `pbPeCP…`).
2. Ensure the app's `google-services.json` is the **same Firebase project** as
   `/etc/zulip/firebase-credentials.json`.
3. Point the app at `https://zulipinternal.basecomms.com`.
4. Build a **release** APK/AAB, **uninstall** the old app, install the new one, log in.

On login the app auto-registers over E2EE and creates a `Device` row with a real
`push_token_id`.

---

## 7. Verify registration

```bash
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zerver.models import Device; [print(d.user_id, d.push_token_kind, d.push_token_id, d.push_registration_error_code) for d in Device.objects.all()]"'
```
Success = a row with a real `push_token_id` and an **empty** `error_code`
(the old `INVALID_BOUNCER_PUBLIC_KEY` is gone).

---

## 8. Test end-to-end

```bash
# terminal A — watch delivery
tail -f /var/log/zulip/errors.log /var/log/zulip/server.log | grep -iE "push|fcm|firebase|bouncer|test"
```
```bash
# terminal B — send E2EE test push (replace id=8 with the registered user's id)
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zerver.models import UserProfile, Device; from zerver.lib.push_notifications import send_e2ee_test_push_notification; u=UserProfile.objects.get(id=8); d=list(Device.objects.filter(user=u, push_token_id__isnull=False)); print(\"devices:\", len(d)); send_e2ee_test_push_notification(u, d); print(\"sent\")"'
```
Notification should appear on the phone. Also test a real DM/mention:
in Personal settings -> Notifications, enable mobile notifications and
"Send mobile push notifications even if I am online", background the app, then have
another user DM or @-mention you.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `relation "zilencer_remotezulipserver" does not exist` | zilencer migrations not applied | `manage.py migrate` (after enabling zilencer) |
| `ZILENCER_ENABLED: False` despite settings edit | `prod_settings.py` not a symlink to `/etc/zulip/settings.py` | relink, restart |
| `Unknown command: manage_push_registration_encryption_keys` | zilencer not loaded | enable zilencer first (see above) |
| `Device` row shows `INVALID_BOUNCER_PUBLIC_KEY` | app's `bouncerPublicKey` != server public key | rebuild app with correct public key |
| Bouncer 400 `INVALID_REMOTE_PUSH_DEVICE_TOKEN` | token not registered with the bouncer (legacy path) | use E2EE registration via the app |
| `send_test_push_notification` unknown command | not a mgmt command in this version | use `send_e2ee_test_push_notification` via shell / app test button |
| Sent OK but nothing on phone; log `SenderId mismatch` | app Firebase project != bouncer `firebase-credentials.json` | same Firebase project both ends |
| Sent OK but nothing; log `Unregistered`/`NotRegistered` | stale token | reopen app to re-register |
| iOS pushes vanish silently | `APNS_SANDBOX` mismatch vs app build type | match sandbox/production |

---

## 10. Key paths, facts, secrets

- Production settings: `/etc/zulip/settings.py`
  (via symlink `zproject/prod_settings.py` -> `/etc/zulip/settings.py`)
- Production secrets: `/etc/zulip/zulip-secrets.conf`
- FCM credentials: `/etc/zulip/firebase-credentials.json`
- Restart: `su zulip -c '/home/zulip/deployments/current/scripts/restart-server'`
- Logs: `/var/log/zulip/errors.log`, `/var/log/zulip/server.log`

**Never commit or share:**
- E2EE **private** key (in `zulip-secrets.conf`)
- `firebase-credentials.json`, APNs `.p8`
- API keys (regenerate any that were pasted into chats/notes)

Only the E2EE **public** key belongs in the app.
