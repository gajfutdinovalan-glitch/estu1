from __future__ import annotations

import json
import re
from contextlib import closing
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from portable_core import (
    ApiError, assert_module, assert_permission, connect, json_load,
    permissions_for_user, transaction, write_audit,
)

MOSCOW = timezone(timedelta(hours=3))
SHIFT_IDS = ("day_1", "day_2", "night_1", "night_2")
DEFAULT_SETTINGS = {"anchorDate": "2026-10-01", "dayStart": "08:00", "nightStart": "20:00"}


def validate_settings(value: dict[str, Any]) -> dict[str, str]:
    try:
        anchor = date.fromisoformat(str(value["anchorDate"]))
        hours = []
        for key in ("dayStart", "nightStart"):
            raw = str(value[key])
            if not re.fullmatch(r"\d{2}:\d{2}", raw):
                raise ValueError()
            parsed = time.fromisoformat(raw)
            hours.append(parsed.hour * 60 + parsed.minute)
        if (hours[1] - hours[0]) % 1440 != 720:
            raise ValueError()
    except (ValueError, KeyError, TypeError) as exc:
        raise ApiError(400, "Укажите дату начала цикла и начало двух смен с интервалом 12 часов.") from exc
    return {"anchorDate": anchor.isoformat(), "dayStart": str(value["dayStart"]), "nightStart": str(value["nightStart"])}


def shift_catalog(connection) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute("SELECT id,name,kind,team FROM work_shifts ORDER BY kind,team")]


def schedule_settings(connection) -> dict[str, str]:
    row = connection.execute("SELECT value FROM app_meta WHERE key='to_shift_schedule'").fetchone()
    return validate_settings(json_load(row["value"] if row else None, DEFAULT_SETTINGS))


def shift_for_instant(settings: dict[str, str], instant: datetime | None = None) -> dict[str, Any]:
    current = instant or datetime.now(MOSCOW)
    current = current.replace(tzinfo=MOSCOW) if current.tzinfo is None else current.astimezone(MOSCOW)
    boundaries = []
    for day_offset in (-1, 0):
        work_date = current.date() + timedelta(days=day_offset)
        for kind, key in (("day", "dayStart"), ("night", "nightStart")):
            start = datetime.combine(work_date, time.fromisoformat(settings[key]), MOSCOW)
            if start <= current < start + timedelta(hours=12):
                boundaries.append((start, kind, work_date))
    if len(boundaries) != 1:
        raise ApiError(500, "Не удалось определить текущую смену.")
    start, kind, work_date = boundaries[0]
    offset = (work_date - date.fromisoformat(settings["anchorDate"])).days % 4
    team = 1 if offset < 2 else 2
    return {"id": f"{kind}_{team}", "kind": kind, "team": team,
            "workDate": work_date.isoformat(), "startsAt": start.isoformat(),
            "endsAt": (start + timedelta(hours=12)).isoformat()}


def snapshot(connection, instant: datetime | None = None) -> dict[str, Any]:
    settings = schedule_settings(connection)
    return {"settings": settings, "timezone": "Europe/Moscow", "shifts": shift_catalog(connection),
            "current": shift_for_instant(settings, instant)}


def public_schedule() -> dict[str, Any]:
    with closing(connect()) as connection:
        return snapshot(connection)


def get_schedule(user: dict[str, Any], start: str = "", days: str = "14") -> dict[str, Any]:
    assert_module(user, "shifts")
    try:
        first = date.fromisoformat(start) if start else datetime.now(MOSCOW).date()
        count = int(days)
        if not 1 <= count <= 62:
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise ApiError(400, "Укажите начальную дату и период от 1 до 62 дней.") from exc
    with closing(connect()) as connection:
        result = snapshot(connection)
        anchor = date.fromisoformat(result["settings"]["anchorDate"])
        result["calendar"] = []
        for i in range(count):
            work_date = first + timedelta(days=i)
            team = 1 if (work_date - anchor).days % 4 < 2 else 2
            result["calendar"].append({"date": work_date.isoformat(), "team": team,
                                       "dayShiftId": f"day_{team}", "nightShiftId": f"night_{team}"})
        result["canManage"] = permissions_for_user(user).get("manageShifts", False)
        return result


def save_schedule(body: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    assert_module(user, "shifts")
    assert_permission(user, "manageShifts")
    settings = validate_settings(body)
    with transaction() as connection:
        previous = schedule_settings(connection)
        connection.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES('to_shift_schedule',?)",
                           (json.dumps(settings, ensure_ascii=False),))
        write_audit(connection, user, "update", "shift_schedule", "to", {"before": previous, "after": settings})
    return get_schedule(user)


def validate_shift(scope: str, value: Any, legacy: bool = False) -> str | None:
    code = str(value or "").strip()
    if scope != "master":
        if code:
            raise ApiError(400, "Смену можно назначить только профилю участка заявочных ремонтов.")
        return None
    if not code and legacy:
        return None
    if code not in SHIFT_IDS:
        raise ApiError(400, "Выберите одну из четырёх смен участка заявочных ремонтов.")
    return code
