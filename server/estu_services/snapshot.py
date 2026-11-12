"""Snapshot application service."""
from __future__ import annotations

from typing import Any
from portable_core import board_sort_key, connect, modules_for_user, permissions_for_user, public_user
import portable_workflow as workflow
from estu_services.requests import request_response


def get_state(user: dict[str, Any], include_history: bool, include_navigation: bool) -> dict[str, Any]:
    with connect() as connection:
        can_all = permissions_for_user(user).get("viewAllRequests", False)
        departments = (
            [row["name"] for row in connection.execute("SELECT name FROM departments ORDER BY sort_order,name")]
            if can_all else [user.get("department")]
        )
        fleet_rows = connection.execute("SELECT board,model FROM fleet WHERE is_active=1").fetchall()
        fleet = sorted((dict(row) for row in fleet_rows), key=lambda item: board_sort_key(item["board"]))

        request_sql = """
          SELECT r.*,u.display_name assigned_to FROM requests r
          LEFT JOIN users u ON u.id=r.assigned_user_id
        """
        parameters: tuple[Any, ...] = ()
        if not can_all:
            request_sql += " WHERE r.department=?"
            parameters = (user.get("department"),)
        request_sql += " ORDER BY r.created_at DESC"
        requests = []
        for row in connection.execute(request_sql, parameters):
            if not workflow.can_read(connection,row,user):
                continue
            item = request_response(connection, row["id"])
            if item is not None:
                requests.append(item)

        history: list[dict[str, Any]] | None = None
        if include_history:
            history_sql = """
              SELECT h.*,u.display_name completed_by FROM repair_history h
              LEFT JOIN users u ON u.id=h.completed_by_user_id
            """
            history_parameters: tuple[Any, ...] = ()
            if not can_all:
                history_sql += " WHERE h.department=?"
                history_parameters = (user.get("department"),)
            history_sql += " ORDER BY h.work_date DESC,h.created_at DESC"
            history = [{
                "id": row["id"], "board": row["board"], "model": row["model"],
                "date": row["work_date"], "department": row["department"],
                "description": row["description"], "workDone": row["work_done"],
                "status": "rejected" if row["source"] == "отклонённая заявка" else "completed", "note": row["note"], "source": row["source"],
                "flow": workflow.public_flow(connection,connection.execute("SELECT request_id FROM request_flow WHERE history_id=?",(row["id"],)).fetchone()[0]) if connection.execute("SELECT request_id FROM request_flow WHERE history_id=?",(row["id"],)).fetchone() else None,
                "completedBy": row["completed_by"],
            } for row in connection.execute(history_sql, history_parameters)]

        navigation: list[dict[str, Any]] | None = None
        if include_navigation and "navigation" in modules_for_user(user):
            rows = connection.execute("""
              SELECT n.*,u.display_name updated_by FROM navigation_equipment n
              JOIN fleet f ON f.board=n.board
              LEFT JOIN users u ON u.id=n.updated_by_user_id
              WHERE f.is_active=1
            """).fetchall()
            navigation = sorted(({
                "board": row["board"], "informer": row["informer_type"],
                "orbita": bool(row["has_navigator"]), "ai": bool(row["is_ai_orbita"]),
                "note": row["note"], "updatedAt": row["updated_at"], "updatedBy": row["updated_by"],
            } for row in rows), key=lambda item: board_sort_key(item["board"]))

        if permissions_for_user(user).get("reassignRequests"):
            assignable = [{
                "id": row["id"], "username": row["username"], "displayName": row["display_name"],
                "role": row["role"], "department": row["department"],
            } for row in connection.execute(
                "SELECT id,username,display_name,role,department FROM users WHERE is_active=1 AND role='executor' ORDER BY department,display_name"
            )]
        else:
            assignable = [{
                "id": user["id"], "username": user["username"], "displayName": user["display_name"],
                "role": user["role"], "department": user.get("department"),
            }]
        return {
            "history": history, "fleet": fleet, "navigation": navigation,
            "requests": requests, "departments": departments, "assignableUsers": assignable,
            "routingDepartments": [r["name"] for r in connection.execute("SELECT name FROM departments ORDER BY sort_order,name")],
            "currentUser": public_user(user), "permissions": permissions_for_user(user),
            "fleetCatalogV2": True,
        }
