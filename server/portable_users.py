from __future__ import annotations

import json
import secrets
import sqlite3
from typing import Any

from portable_core import (
    ALLOWED_MODULES,
    ApiError,
    PASSWORD_ITERATIONS,
    TO_DEPARTMENT,
    access_scope_for_role,
    assert_permission,
    connect,
    default_modules,
    default_permissions,
    new_id,
    now_iso,
    password_digest,
    permissions_for_user,
    public_user,
    required,
    role_for_scope,
    set_password,
    text,
    transaction,
    write_audit,
)
from portable_shifts import validate_shift


def _default_department(connection: sqlite3.Connection, scope: str, preferred: Any = None) -> str | None:
    if scope == "master":
        return TO_DEPARTMENT
    if scope in ("admin", "management"):
        return None
    value = text(preferred)
    if value and connection.execute("SELECT 1 FROM departments WHERE name=?", (value,)).fetchone():
        return value
    if scope != "rel":
        return None
    for candidate in ("Электронщики", "Электроучасток", "УЗР"):
        if connection.execute("SELECT 1 FROM departments WHERE name=?", (candidate,)).fetchone():
            return candidate
    row = connection.execute("SELECT name FROM departments ORDER BY sort_order,name LIMIT 1").fetchone()
    if row is None:
        raise ApiError(400, "В базе нет подразделений для привязки участка.")
    return str(row["name"])


def _modules_json(value: Any, role: str) -> str:
    if value is not None and (not isinstance(value, list) or any(not isinstance(item, str) or item not in ALLOWED_MODULES for item in value)):
        raise ApiError(400, "Некорректный список доступных систем.")
    if role == "admin":
        modules = default_modules(role)
    elif value is None:
        modules = default_modules(role)
    else:
        modules = list(dict.fromkeys(str(item) for item in value if str(item) in ALLOWED_MODULES))
    return json.dumps(modules, ensure_ascii=False, separators=(",", ":"))


def _permissions_json(value: Any, role: str, scope: str) -> str:
    result = default_permissions(role, scope)
    if value is not None and not isinstance(value, dict):
        raise ApiError(400, "Некорректный список прав.")
    if isinstance(value, dict):
        for key in result:
            if key in value:
                if not isinstance(value[key], bool):
                    raise ApiError(400, "Права доступа должны иметь значение да или нет.")
                result[key] = value[key]
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def _generated_username(connection: sqlite3.Connection, scope: str) -> str:
    while True:
        username = f"{scope}-{secrets.token_hex(4)}".lower()
        if connection.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone() is None:
            return username


def create_user(body: dict[str, Any], actor: dict[str, Any] | None, forced_role: str | None = None) -> dict[str, Any]:
    if actor is not None:
        assert_permission(actor, "manageUsers")
    display_name = required(body.get("displayName"), "Название")
    password = required(body.get("password"), "Пароль")
    if len(password) < 4:
        raise ApiError(400, "Пароль должен содержать не менее 4 символов.")
    scope = access_scope_for_role(forced_role) if forced_role else text(body.get("accessScope"), "rel")
    role = forced_role or role_for_scope(scope)
    shift_id = validate_shift(scope, body.get("shiftId"))
    with transaction() as connection:
        department = _default_department(connection, scope, body.get("department"))
        username = text(body.get("username")).lower() or _generated_username(connection, scope)
        if connection.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise ApiError(409, "Профиль с таким техническим логином уже существует.")
        user_id = new_id()
        salt = secrets.token_bytes(16)
        digest = password_digest(password, salt)
        now = now_iso()
        connection.execute("""
          INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,
                            role,access_scope,department,modules_json,permissions_json,is_active,
                            created_at,updated_at,shift_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (user_id,username,display_name,digest,salt,PASSWORD_ITERATIONS,role,scope,department,
              _modules_json(body.get("modules"),role),_permissions_json(body.get("permissions"),role,scope),1,now,now,shift_id))
        row = connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        write_audit(connection,actor or dict(row),"setup" if actor is None else "create","user",user_id,{"username":username,"scope":scope,"shiftId":shift_id})
        return public_user(row) or {}


def list_users(actor: dict[str, Any]) -> list[dict[str, Any]]:
    assert_permission(actor, "manageUsers")
    with connect() as connection:
        rows = connection.execute("SELECT * FROM users ORDER BY is_active DESC,access_scope,display_name").fetchall()
        result=[]
        for row in rows:
            item=public_user(row) or {}
            item["lastLoginAt"]=row["last_login_at"]
            result.append(item)
        return result


def update_user(user_id: str, body: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any] | None:
    assert_permission(actor,"manageUsers")
    with transaction() as connection:
        current=connection.execute("SELECT * FROM users WHERE id=?",(user_id,)).fetchone()
        if current is None:
            return None
        display_name=required(body.get("displayName",current["display_name"]),"Название")
        scope=text(body.get("accessScope"),current["access_scope"] or access_scope_for_role(current["role"]))
        role=role_for_scope(scope)
        legacy=scope=="master" and current["access_scope"]=="master" and not current["shift_id"]
        shift_id=validate_shift(scope,body.get("shiftId",current["shift_id"] if scope==current["access_scope"] else None),legacy)
        department=_default_department(connection,scope,body.get("department",current["department"]))
        active_value=body.get("isActive",bool(current["is_active"]))
        if not isinstance(active_value,bool):
            raise ApiError(400,"Укажите, активен ли профиль.")
        is_active=int(active_value)
        changed_scope=scope!=current["access_scope"]
        modules_json=_modules_json(body.get("modules",None if changed_scope else json.loads(current["modules_json"] or "null")),role)
        permissions_json=_permissions_json(body.get("permissions",None if changed_scope else json.loads(current["permissions_json"] or "null")),role,scope)
        check_user={"role":role,"access_scope":scope,"permissions_json":permissions_json}
        next_permissions=permissions_for_user(check_user)
        next_modules=json.loads(modules_json)
        if user_id==actor["id"] and (not is_active or role!="admin" or not next_permissions["manageUsers"] or "users" not in next_modules):
            raise ApiError(409,"Нельзя отключить свой профиль или снять с него доступ к администрированию.")
        if current["role"]=="admin" and (role!="admin" or not is_active):
            admins=connection.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=1").fetchone()[0]
            if admins<=1:
                raise ApiError(409,"В системе должен остаться хотя бы один активный администратор.")
        connection.execute("""
          UPDATE users SET display_name=?,role=?,access_scope=?,department=?,modules_json=?,permissions_json=?,
                           is_active=?,updated_at=?,shift_id=? WHERE id=?
        """,(display_name,role,scope,department,modules_json,permissions_json,is_active,now_iso(),shift_id,user_id))
        if not is_active:
            connection.execute("DELETE FROM user_sessions WHERE user_id=?",(user_id,))
        write_audit(connection,actor,"update","user",user_id,{"accessScope":scope,"role":role,"department":department,"shiftId":shift_id,"modules":next_modules,"isActive":bool(is_active)})
        return public_user(connection.execute("SELECT * FROM users WHERE id=?",(user_id,)).fetchone())


def reset_password(user_id: str, body: dict[str, Any], actor: dict[str, Any]) -> bool:
    assert_permission(actor,"manageUsers")
    password=required(body.get("password"),"Новый пароль")
    with transaction() as connection:
        if connection.execute("SELECT 1 FROM users WHERE id=?",(user_id,)).fetchone() is None:
            return False
        set_password(connection,user_id,password)
        connection.execute("DELETE FROM user_sessions WHERE user_id=?",(user_id,))
        write_audit(connection,actor,"reset_password","user",user_id)
        return True


def delete_user(user_id: str, actor: dict[str, Any]) -> bool:
    assert_permission(actor,"manageUsers")
    if user_id==actor["id"]:
        raise ApiError(409,"Нельзя удалить текущий профиль.")
    with transaction() as connection:
        current=connection.execute("SELECT * FROM users WHERE id=?",(user_id,)).fetchone()
        if current is None:
            return False
        if current["role"]=="admin" and current["is_active"]:
            admins=connection.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=1").fetchone()[0]
            if admins<=1:
                raise ApiError(409,"В системе должен остаться хотя бы один активный администратор.")
        write_audit(connection,actor,"delete","user",user_id,{"displayName":current["display_name"],"role":current["role"]})
        connection.execute("DELETE FROM users WHERE id=?",(user_id,))
        return True


def audit_log(actor: dict[str, Any]) -> list[dict[str, Any]]:
    assert_permission(actor, "viewAudit")
    with connect() as connection:
        return [{"id":row["id"],"actor":row["actor"],"action":row["action"],"entityType":row["entity_type"],
                 "entityId":row["entity_id"],"details":row["details"],"createdAt":row["created_at"]}
                for row in connection.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300")]
