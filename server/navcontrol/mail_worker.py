from __future__ import annotations

import base64
import email
import imaplib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from email.header import decode_header
from email.utils import parsedate_to_datetime


PORT = int(os.environ.get("ESTU_PORT", "8080"))
BASE = f"http://localhost:{PORT}/api/nav-control/worker"


def request(path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data)
    if data is not None:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(req, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def decode(value: str | None) -> str:
    parts = []
    for item, charset in decode_header(value or ""):
        if isinstance(item, bytes):
            parts.append(item.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(item)
    return "".join(parts)


def matches(value: str, pattern: str) -> bool:
    return not pattern.strip() or pattern.casefold() in value.casefold()


def email_date(message: email.message.Message) -> datetime:
    try:
        value = parsedate_to_datetime(message.get("Date"))
        return value if value.tzinfo else value.astimezone()
    except Exception:
        return datetime.now().astimezone()


def sync_once(config: dict) -> None:
    client = None
    max_uid = int(config.get("lastUid") or 0)
    imported = 0
    processed = 0
    try:
        client_type = imaplib.IMAP4_SSL if config.get("useSsl", True) else imaplib.IMAP4
        client = client_type(config["imapHost"], int(config.get("imapPort") or 993), timeout=45)
        client.login(config["username"], config["password"])
        status, _ = client.select(config.get("mailFolder") or "INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("Не удалось открыть папку почты.")
        status, data = client.uid("search", None, "ALL")
        if status != "OK":
            raise RuntimeError("Не удалось получить список писем.")
        all_uids = [int(item) for item in (data[0] or b"").split()]
        candidates = sorted(set([uid for uid in all_uids if uid > max_uid] + all_uids[-50:]))
        for uid in candidates:
            status, parts = client.uid("fetch", str(uid), "(RFC822)")
            if status != "OK":
                continue
            raw = next((part[1] for part in parts if isinstance(part, tuple) and len(part) > 1), None)
            if not raw:
                continue
            message = email.message_from_bytes(raw)
            subject = decode(message.get("Subject"))
            sender = decode(message.get("From"))
            if not matches(subject, config.get("subjectFilter", "")) or not matches(sender, config.get("senderFilter", "")):
                max_uid = max(max_uid, uid)
                continue
            sent_at = email_date(message)
            attachment_index = 0
            for part in message.walk():
                filename = decode(part.get_filename())
                if not filename.lower().endswith(".xlsx"):
                    continue
                body = part.get_payload(decode=True)
                if not body:
                    continue
                attachment_index += 1
                processed += 1
                result = request("/import", {
                    "filename": filename,
                    "contentBase64": base64.b64encode(body).decode("ascii"),
                    "source": "email",
                    "emailUid": uid,
                    "emailSubject": subject,
                    "emailFrom": sender,
                    "emailDate": sent_at.isoformat(),
                    "fallbackHour": sent_at.hour,
                })
                imported += int(result.get("imported") or 0)
            max_uid = max(max_uid, uid)
        request("/state", {"lastUid": max_uid, "error": "", "imported": imported, "success": True})
    except Exception as exc:
        try:
            request("/state", {"lastUid": max_uid, "error": str(exc), "imported": imported, "success": False})
        except Exception:
            pass
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass


def main() -> None:
    next_check = 0.0
    while True:
        try:
            config = request("/config")
            trigger = bool(config.get("trigger"))
            interval = max(60, int(config.get("pollMinutes") or 5) * 60)
            now = time.time()
            ready = config.get("autoSync") and config.get("imapHost") and config.get("username") and config.get("password")
            if ready and (trigger or now >= next_check):
                sync_once(config)
                next_check = time.time() + interval
            elif trigger and not ready:
                request("/state", {"lastUid": int(config.get("lastUid") or 0), "error": "Заполните настройки почты и включите автозагрузку.", "imported": 0, "success": False})
        except (urllib.error.URLError, ConnectionError):
            pass
        except Exception as exc:
            print(f"Navigation mail worker: {exc}", file=sys.stderr, flush=True)
        time.sleep(15)


if __name__ == "__main__":
    main()
