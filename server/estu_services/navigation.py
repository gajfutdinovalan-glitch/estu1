"""Navigation application service."""
from __future__ import annotations

import sqlite3
from typing import Any
from portable_core import ApiError, assert_module, assert_permission, connect, now_iso, text, transaction, write_audit
from estu_services.lookups import model_for_board


def navigation_record(connection: sqlite3.Connection, board: str) -> dict[str, Any] | None:
    row = connection.execute("""
      SELECT n.*,u.display_name updated_by FROM navigation_equipment n
      LEFT JOIN users u ON u.id=n.updated_by_user_id WHERE n.board=?
    """, (board,)).fetchone()
    if row is None:
        return None
    return {"board":row["board"],"informer":row["informer_type"],"orbita":bool(row["has_navigator"]),
            "ai":bool(row["is_ai_orbita"]),"note":row["note"],"updatedAt":row["updated_at"],"updatedBy":row["updated_by"]}


def get_navigation(board: str, user: dict[str, Any]) -> dict[str, Any] | None:
    assert_module(user, "navigation")
    with connect() as connection:
        return navigation_record(connection, board)


def save_navigation(board: str, body: dict[str, Any], user: dict[str, Any], skip_audit: bool = False) -> dict[str, Any]:
    assert_module(user, "navigation")
    assert_permission(user, "manageNavigation")
    with transaction() as connection:
        model = model_for_board(connection, board)
        default_informer = "Искра" if "маз" in model.casefold() else ("Селена" if board.isdigit() and 2300 <= int(board) <= 2340 else "ИР")
        informer = text(body.get("informer"), default_informer)
        if informer not in ("Селена", "Искра", "ИР"):
            raise ApiError(400, "Неизвестный тип информатора.")
        orbita = bool(body.get("orbita"))
        ai = bool(body.get("ai"))
        if ai:
            orbita = True
        note = text(body.get("note"))
        if len(note) > 4000:
            raise ApiError(400, "Заметка не должна превышать 4000 символов.")
        old = navigation_record(connection, board)
        connection.execute("""
          INSERT INTO navigation_equipment(board,informer_type,has_navigator,is_ai_orbita,note,updated_at,updated_by_user_id)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(board) DO UPDATE SET informer_type=excluded.informer_type,has_navigator=excluded.has_navigator,
             is_ai_orbita=excluded.is_ai_orbita,note=excluded.note,updated_at=excluded.updated_at,
             updated_by_user_id=excluded.updated_by_user_id
        """, (board,informer,int(orbita),int(ai),note,now_iso(),user["id"]))
        current = navigation_record(connection, board) or {}
        if not skip_audit:
            write_audit(connection,user,"update","navigation_equipment",board,{"old":old,"current":current})
        return current


def import_navigation(body: dict[str, Any], user: dict[str, Any]) -> int:
    count = 0
    for item in body.get("records") or []:
        board = text(item.get("board"))
        if not board:
            continue
        with connect() as connection:
            active = connection.execute("SELECT 1 FROM fleet WHERE board=? AND is_active=1", (board,)).fetchone()
        if active:
            save_navigation(board,item,user,True)
            count += 1
    if count:
        with transaction() as connection:
            write_audit(connection,user,"import_local","navigation_equipment",None,{"records":count})
    return count
