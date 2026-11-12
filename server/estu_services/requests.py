"""Requests application service."""
from __future__ import annotations

import sqlite3
from typing import Any
from portable_core import ApiError, assert_permission, new_id, now_iso, permissions_for_user, required, text, today_iso, transaction, write_audit
import portable_workflow as workflow
from estu_services.lookups import model_for_board, department_exists, default_department


def validate_status(value: Any, fallback: str = "waiting") -> str:
    status = text(value, fallback)
    if status not in ("new", "waiting", "in_progress"):
        raise ApiError(400, "Неизвестный статус заявки.")
    return status


def validate_assignment(
    connection: sqlite3.Connection,
    value: Any,
    department: str,
    user: dict[str, Any],
) -> str | None:
    user_id = text(value)
    if not user_id:
        return None
    row = connection.execute(
        "SELECT id,role,department FROM users WHERE id=? AND is_active=1", (user_id,)
    ).fetchone()
    if row is None or row["role"] != "executor" or row["department"] != department:
        raise ApiError(400, "Исполнитель должен относиться к выбранному подразделению.")
    if not permissions_for_user(user).get("reassignRequests") and user_id != user["id"]:
        raise ApiError(403, "Исполнитель может назначить заявку только себе.")
    return user_id


def request_response(connection: sqlite3.Connection, request_id: str) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT r.*,u.display_name assigned_to
        FROM requests r LEFT JOIN users u ON u.id=r.assigned_user_id
        WHERE r.id=?
        """,
        (request_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"], "board": row["board"], "model": row["model"],
        "department": row["department"], "description": row["description"],
        "createdBy": row["created_by"], "createdAt": row["created_at"],
        "status": row["status"], "assignedUserId": row["assigned_user_id"],
        "assignedTo": row["assigned_to"], "externalSource": row["external_source"],
        "externalId": row["external_id"],
        "flow": workflow.public_flow(connection,request_id),
    }


def add_request(body: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    assert_permission(user, "createRequests")
    with transaction() as connection:
        board = required(body.get("board"), "Бортовой номер")
        model = model_for_board(connection, board)
        department = default_department(connection, user)
        description = required(body.get("description"), "Описание неисправности")
        status = validate_status(body.get("status"), "waiting")
        assigned = validate_assignment(connection, body.get("assignedUserId"), department, user)
        request_id = new_id()
        now = now_iso()
        connection.execute("""
          INSERT INTO requests(id,board,model,department,description,created_by,created_at,status,
                               assigned_user_id,created_by_user_id,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)
        """, (request_id,board,model,department,description,user["display_name"],now,status,assigned,user["id"],now))
        write_audit(connection,user,"create","request",request_id,{"board":board,"department":department,"status":status})
        workflow.intake(connection,request_id,user,body.get("intake")=="general")
        return request_response(connection, request_id) or {}


def update_request(request_id: str, body: dict[str, Any], user: dict[str, Any]) -> dict[str, Any] | None:
    assert_permission(user, "editRequests")
    with transaction() as connection:
        current = connection.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
        if current is None:
            return None
        workflow.assert_owner(connection,current,user)
        current_flow = workflow.flow(connection,request_id)
        if current_flow and body.get("flowVersion") != current_flow["version"]:
            raise ApiError(409,"Заявка уже изменена. Обновите список.")
        board = text(body.get("board"), current["board"])
        model = model_for_board(connection, board)
        department = (
            text(body.get("department"), current["department"])
            if permissions_for_user(user).get("reassignRequests") else text(user.get("department"), current["department"])
        )
        if not department_exists(connection, department):
            raise ApiError(400, "Неизвестное подразделение.")
        if department != current["department"] or text(body.get("status"),current["status"]) != current["status"]:
            raise ApiError(409,"Изменение очереди и статуса выполняется через решение по заявке.")
        description = required(body.get("description", current["description"]), "Описание неисправности")
        created_by = text(body.get("createdBy"), current["created_by"])
        status = validate_status(body.get("status"), current["status"])
        assignment_value = body.get("assignedUserId", current["assigned_user_id"])
        assigned = validate_assignment(connection, assignment_value, department, user)
        connection.execute("""
          UPDATE requests SET board=?,model=?,department=?,description=?,created_by=?,status=?,
                              assigned_user_id=?,updated_at=? WHERE id=?
        """, (board,model,department,description,created_by,status,assigned,now_iso(),request_id))
        write_audit(connection,user,"update","request",request_id,{"board":board,"department":department,"status":status,"assignedUserId":assigned})
        before_flow = workflow.ensure(connection,current)
        connection.execute("UPDATE request_flow SET version=version+1 WHERE request_id=?",(request_id,))
        workflow.event(connection,request_id,user,"edit","Обновлены сведения о неисправности.",before_flow,workflow.flow(connection,request_id),current["department"],department)
        return request_response(connection, request_id)


def delete_request(request_id: str, user: dict[str, Any]) -> bool:
    assert_permission(user, "deleteRequests")
    with transaction() as connection:
        current = connection.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
        if current is None:
            return False
        workflow.close(connection,current,user,"deleted","Удалена администратором",None)
        connection.execute("DELETE FROM requests WHERE id=?", (request_id,))
        write_audit(connection,user,"delete","request",request_id,{"board":current["board"],"description":current["description"]})
        return True


def complete_request(request_id: str, body: dict[str, Any], user: dict[str, Any]) -> dict[str, str] | None:
    assert_permission(user, "completeRequests")
    work_done = required(body.get("workDone"), "Выполненные работы")
    with transaction() as connection:
        current = connection.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
        if current is None:
            return None
        workflow.assert_owner(connection,current,user)
        current_flow = workflow.flow(connection,request_id)
        if current_flow and current_flow["stage"] != "work":
            raise ApiError(409,"Сначала примите заявку в работу.")
        if current_flow and body.get("flowVersion") != current_flow["version"]:
            raise ApiError(409,"Заявка уже изменена. Обновите список.")
        history_id = new_id()
        now = now_iso()
        connection.execute("""
          INSERT INTO repair_history(id,board,model,work_date,department,description,work_done,source,
                                     external_source,external_id,created_at,updated_at,completed_by_user_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (history_id,current["board"],current["model"],today_iso(),current["department"],current["description"],
              work_done,"создано в журнале",current["external_source"],current["external_id"],now,now,user["id"]))
        workflow.close(connection,current,user,"completed",work_done,history_id)
        connection.execute("DELETE FROM requests WHERE id=?", (request_id,))
        write_audit(connection,user,"complete","request",request_id,{"historyId":history_id,"board":current["board"]})
        return {"id": history_id}
