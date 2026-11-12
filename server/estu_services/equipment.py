"""Equipment application service."""
from __future__ import annotations

import json
import sqlite3
from typing import Any
from portable_core import ApiError, assert_module, assert_permission, board_sort_key, connect, now_iso, required, text, transaction, write_audit


def _normalize_bso_record(value: dict[str, Any]) -> dict[str, Any]:
    board = required(value.get("board", value.get("number")), "Бортовой номер")
    devices: list[dict[str, Any]] = []
    sources = [("cash",0,"Касса",value.get("cash"))]
    cubes = list(value.get("cubes") or [])
    sources.extend(("cube",index+1,f"Куб {index+1}",cubes[index] if index < len(cubes) else None) for index in range(5))
    for device_type,slot,label,source in sources:
        source = source or {}
        status = text(source.get("status"), "empty")
        if status not in ("installed","removed","empty"):
            raise ApiError(400, f"Некорректное состояние устройства: {label}.")
        full = text(source.get("full")) or None
        short = text(source.get("short")) or None
        if status == "installed" and not full and not short:
            status = "empty"
        if status != "installed":
            full = short = None
        devices.append({"deviceType":device_type,"slot":slot,"deviceLabel":label,"status":status,"full":full,"short":short})
    return {"board":board,"note":text(value.get("note")),"devices":devices}


def get_bso(user: dict[str, Any]) -> list[dict[str, Any]]:
    assert_module(user,"bso")
    with connect() as connection:
        vehicles = connection.execute("SELECT board,model FROM fleet WHERE is_active=1").fetchall()
        result=[]
        for vehicle in sorted(vehicles,key=lambda row:board_sort_key(row["board"])):
            note_row=connection.execute("SELECT note FROM bso_board_notes WHERE board=?",(vehicle["board"],)).fetchone()
            devices={(row["device_type"],row["slot"]):row for row in connection.execute("SELECT * FROM bso_devices WHERE board=?",(vehicle["board"],))}
            def device(kind: str, slot: int) -> dict[str, Any]:
                row=devices.get((kind,slot))
                return {"full":row["full_number"] if row else "","short":row["short_number"] if row else "","status":row["status"] if row else "empty"}
            result.append({"number":vehicle["board"],"board":vehicle["board"],"model":vehicle["model"],
                           "cash":device("cash",0),"cubes":[device("cube",slot) for slot in range(1,6)],
                           "note":note_row["note"] if note_row else ""})
        return result


def save_bso_records(values: list[dict[str, Any]], user: dict[str, Any], replace: bool) -> int:
    assert_module(user,"bso")
    assert_permission(user,"manageBso")
    records=[_normalize_bso_record(value) for value in values]
    if not records and not replace:
        raise ApiError(400,"Нет данных БСО для сохранения.")
    if len({record["board"] for record in records}) != len(records):
        raise ApiError(400,"Борт повторяется в загружаемых данных.")
    with transaction() as connection:
        active={row["board"] for row in connection.execute("SELECT board FROM fleet WHERE is_active=1")}
        for record in records:
            if record["board"] not in active:
                raise ApiError(400,f"Борт {record['board']} отсутствует в активном парке ЕСТУ.")
        before={(row["board"],row["device_type"],row["slot"]):dict(row) for row in connection.execute("SELECT * FROM bso_devices")}
        if replace:
            connection.execute("DELETE FROM bso_devices")
            connection.execute("DELETE FROM bso_board_notes")
        for record in records:
            connection.execute("INSERT INTO bso_board_notes(board,note,updated_at) VALUES(?,?,?) ON CONFLICT(board) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at",(record["board"],record["note"],now_iso()))
            connection.execute("DELETE FROM bso_devices WHERE board=?",(record["board"],))
            for device in record["devices"]:
                try:
                    connection.execute("INSERT INTO bso_devices(board,device_type,slot,full_number,short_number,status,updated_at) VALUES(?,?,?,?,?,?,?)",
                                      (record["board"],device["deviceType"],device["slot"],device["full"],device["short"],device["status"],now_iso()))
                except sqlite3.IntegrityError as exc:
                    raise ApiError(409,"Номер кассы или куба уже используется на другом борту.") from exc
        after={(row["board"],row["device_type"],row["slot"]):dict(row) for row in connection.execute("SELECT * FROM bso_devices")}
        keys=set(after) | (set(before) if replace else {key for key in before if key[0] in {r['board'] for r in records}})
        for key in keys:
            old=before.get(key); new=after.get(key)
            old_full=old["full_number"] if old else None; old_short=old["short_number"] if old else None
            new_full=new["full_number"] if new else None; new_short=new["short_number"] if new else None
            if old_full == new_full and old_short == new_short:
                continue
            board,kind,slot=key
            details={"board":board,"deviceType":kind,"slot":slot,"deviceLabel":"Касса" if kind=="cash" else f"Куб {slot}",
                     "oldStatus":old["status"] if old else "empty","oldFull":old_full,"oldShort":old_short,
                     "newStatus":new["status"] if new else "empty","newFull":new_full,"newShort":new_short}
            write_audit(connection,user,"number_change","bso_device",f"{board}:{kind}:{slot}",details)
        write_audit(connection,user,"import" if replace else "update","bso",None if replace else records[0]["board"],{"records":len(records)} if replace else None)
        return len(records)


def bso_history(user: dict[str, Any]) -> list[dict[str, Any]]:
    assert_module(user,"bso")
    with connect() as connection:
        result=[]
        for row in connection.execute("SELECT id,actor,details,created_at FROM audit_log WHERE action='number_change' AND entity_type='bso_device' ORDER BY id DESC LIMIT 500"):
            details=json.loads(row["details"] or "{}")
            details.update({"id":row["id"],"actor":row["actor"],"createdAt":row["created_at"]})
            result.append(details)
        return result
