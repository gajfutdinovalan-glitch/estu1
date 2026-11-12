"""Fleet application service."""
from __future__ import annotations

from typing import Any
from portable_core import ApiError, assert_permission, now_iso, required, transaction, write_audit


def add_fleet(body: dict[str, Any], user: dict[str, Any]) -> None:
    assert_permission(user, "manageFleet")
    board = required(body.get("board"), "Бортовой номер")
    model = required(body.get("model"), "Модель")
    with transaction() as connection:
        connection.execute("""
          INSERT INTO fleet(board,model,is_active) VALUES(?,?,1)
          ON CONFLICT(board) DO UPDATE SET model=excluded.model,is_active=1
        """, (board,model))
        informer = "Искра" if "маз" in model.casefold() else ("Селена" if board.isdigit() and 2300 <= int(board) <= 2340 else "ИР")
        connection.execute("""
          INSERT OR IGNORE INTO navigation_equipment(board,informer_type,has_navigator,is_ai_orbita,note,updated_at,updated_by_user_id)
          VALUES(?,?,0,0,'',?,?)
        """, (board,informer,now_iso(),user["id"]))
        write_audit(connection,user,"create_or_restore","fleet",board,{"model":model})


def update_fleet(old_board: str, body: dict[str, Any], user: dict[str, Any]) -> None:
    assert_permission(user, "manageFleet")
    new_board = required(body.get("board"), "Бортовой номер")
    model = required(body.get("model"), "Модель")
    with transaction() as connection:
        exists = connection.execute("SELECT 1 FROM fleet WHERE board=?", (old_board,)).fetchone()
        if exists is None:
            raise ApiError(400, "Борт не найден.")
        connection.execute("UPDATE fleet SET board=?,model=?,is_active=1 WHERE board=?", (new_board,model,old_board))
        connection.execute("UPDATE requests SET model=?,updated_at=? WHERE board=?", (model,now_iso(),new_board))
        connection.execute("UPDATE repair_history SET model=?,updated_at=? WHERE board=?", (model,now_iso(),new_board))
        write_audit(connection,user,"update","fleet",old_board,{"newBoard":new_board,"model":model})


def remove_fleet(board: str, user: dict[str, Any]) -> None:
    assert_permission(user, "manageFleet")
    with transaction() as connection:
        if connection.execute("SELECT 1 FROM requests WHERE board=? LIMIT 1", (board,)).fetchone():
            raise ApiError(409, "Нельзя убрать борт с активными заявками.")
        connection.execute("UPDATE fleet SET is_active=0 WHERE board=?", (board,))
        write_audit(connection,user,"deactivate","fleet",board)
