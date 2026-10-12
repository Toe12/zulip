# Zulip Production Logs Guide

Reference for reading live and historical logs on the production server
(`zulip-appcheck`, `basecomms.com`), with a focus on debugging mobile push
notifications.

All logs live in `/var/log/zulip/`. Run these as **root** on the production server.

---

## 1. Log files and what they contain

```bash
ls -la /var/log/zulip/
```

| File | Contents | Use it for |
|---|---|---|
| `errors.log` | all errors / exceptions / tracebacks | first place to look for any failure |
| `server.log` | main application log (Django app, push send path) | general behavior, push logic |
| `django.log` | every HTTP request handled by uwsgi | confirming an API call arrived, status codes |
| `workers.log` | queue-worker output — **push is sent from a worker** | push delivery, queue processing |
| `analytics.log` | bouncer sync / analytics uploads | `send_server_data_to_push_bouncer`, plan/status |
| `tornado.log` | real-time events server | presence, event delivery |
| `send_email.log` | outgoing email | invitations, email notifications |

Push notifications touch mainly: `workers.log`, `server.log`, `errors.log`,
and `analytics.log` (for the bouncer sync).

---

## 2. Watch logs live (tail -f)

**Core two — errors + main app:**
```bash
tail -f /var/log/zulip/errors.log /var/log/zulip/server.log
```

**All logs, filtered to push activity (best while testing a notification):**
```bash
tail -f /var/log/zulip/*.log | grep --line-buffered -iE "push|fcm|firebase|apns|bouncer|test"
```
`--line-buffered` is required — otherwise grep buffers output and you see nothing
until a large chunk accumulates.

**Just the queue worker that delivers push:**
```bash
tail -f /var/log/zulip/workers.log
```

Stop tailing with `Ctrl-C`.

---

## 3. Search historical logs (not just live)

```bash
# recent push-related lines already written
grep -iE "push|fcm|bouncer" /var/log/zulip/errors.log | tail -50

# search across all logs
grep -riE "INVALID_REMOTE_PUSH_DEVICE_TOKEN|SenderId mismatch|INVALID_BOUNCER_PUBLIC_KEY" /var/log/zulip/

# everything around a timestamp
grep "2026-07-23 07:24" /var/log/zulip/server.log
```

Zulip's log-search helper correlates a request across logs by user/email/IP:
```bash
su zulip -c '/home/zulip/deployments/current/scripts/log-search you@basecomms.com'
```

Compressed rotated logs (older history) — search with `zgrep`:
```bash
zgrep -iE "push|bouncer" /var/log/zulip/errors.log.*.gz
```

---

## 4. Check the processes that produce push

Push is delivered by a supervisor-managed queue worker; if it is down, pushes
queue silently and never send.
```bash
supervisorctl status                       # all processes
supervisorctl status | grep -iE "worker|events"
```
All should read `RUNNING`. The relevant worker for push is the missed-message
mobile notifications worker.

Restart a specific worker (or everything) if needed:
```bash
supervisorctl restart all
# or the full app restart
su zulip -c '/home/zulip/deployments/current/scripts/restart-server'
```

---

## 5. Push-testing workflow (two terminals)

```bash
# terminal A — live, filtered
tail -f /var/log/zulip/*.log | grep --line-buffered -iE "push|fcm|firebase|bouncer|test"
```
```bash
# terminal B — fire the E2EE test (replace id=8 with the registered user's id)
su zulip -c '/home/zulip/deployments/current/manage.py shell -c "from zerver.models import UserProfile, Device; from zerver.lib.push_notifications import send_e2ee_test_push_notification; u=UserProfile.objects.get(id=8); d=list(Device.objects.filter(user=u, push_token_id__isnull=False)); print(\"devices:\", len(d)); send_e2ee_test_push_notification(u, d); print(\"sent\")"'
```
Terminal A shows the bouncer call and the FCM result.

---

## 6. Reading common push log lines

| Log line | Meaning | Fix |
|---|---|---|
| `POST /api/v1/remotes/push/test_notification ... 200` | bouncer accepted the send | good |
| `INVALID_REMOTE_PUSH_DEVICE_TOKEN` | token not registered *with the bouncer* | register via E2EE (app), not legacy curl |
| `INVALID_BOUNCER_PUBLIC_KEY` | app's `bouncerPublicKey` != server public key | rebuild app with correct key |
| `SenderId mismatch` / `mismatched-credential` | app Firebase project != bouncer `firebase-credentials.json` | same Firebase project both ends |
| `Unregistered` / `NotRegistered` | stale/expired FCM token | reopen app to re-register |
| `Sending push notification to ... via FCM` (success) | delivered to FCM | if no banner, check app/phone settings |
| authenticated as `zulip-server:<uuid>` | server is registered with the bouncer | good |

---

## 7. Handy one-liners

```bash
# tail only errors, live
tail -f /var/log/zulip/errors.log

# last 100 lines of the worker log
tail -100 /var/log/zulip/workers.log

# count push errors today
grep -c "INVALID_REMOTE_PUSH_DEVICE_TOKEN" /var/log/zulip/*.log

# follow requests to the bouncer endpoints only
tail -f /var/log/zulip/django.log | grep --line-buffered "/api/v1/remotes/"

# disk usage of logs
du -sh /var/log/zulip/
```

---

## 8. Notes

- Logs rotate automatically (logrotate); older ones are gzipped as `*.log.N.gz`.
- Timestamps are in the server's local timezone.
- `django.log` is noisy with internet scanner traffic (e.g. `eval-stdin.php`,
  `/containers/json`) returning 400 — that is harmless background noise, not your app.
- When sharing logs for help, redact device tokens, API keys, and the E2EE private key.
