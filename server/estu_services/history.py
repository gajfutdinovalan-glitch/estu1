"""History application service."""
from __future__ import annotations

from typing import Any
from portable_core import ApiError, assert_permission, now_iso, required, text, transaction, write_audit
from estu_services.lookups import model_for_board, department_exists


def update_history(history_id: str, body: dict[str, Any], user: dict[str, Any]) -> dict[str, str] | None:
    assert_permission(user,"manageHistory")
    with transaction() as connection:
        current=connection.execute("SELECT * FROM repair_history WHERE id=?",(history_id,)).fetchone()
        if current is None:
            return None
        board=text(body.get("board"),current["board"]); model=model_for_board(connection,board,False)
        department=text(body.get("department"),current["department"])
        if not department_exists(connection,department):
            raise ApiError(400,"Неизвестное подразделение.")
        work_date=text(body.get("date"),current["work_date"])
        description=required(body.get("description",current["description"]),"Описание неисправности")
        work_done=text(body.get("workDone"),current["work_done"] or "")
        note=text(body.get("note"),current["note"] or "")
        source=text(body.get("source"),current["source"] or "")
        connection.execute("UPDATE repair_history SET board=?,model=?,work_date=?,department=?,description=?,work_done=?,note=?,source=?,updated_at=? WHERE id=?",
                          (board,model,work_date,department,description,work_done,note,source,now_iso(),history_id))
        write_audit(connection,user,"update","history",history_id,{"board":board,"date":work_date})
        return {"id":history_id}


def delete_history(history_id: str, user: dict[str, Any]) -> bool:
    assert_permission(user,"manageHistory")
    with transaction() as connection:
        current=connection.execute("SELECT board,description FROM repair_history WHERE id=?",(history_id,)).fetchone()
        if current is None:
            return False
        connection.execute("DELETE FROM repair_history WHERE id=?",(history_id,))
        write_audit(connection,user,"delete","history",history_id,{"board":current["board"],"description":current["description"]})
        return True
