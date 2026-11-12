from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from ctypes import wintypes
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "server"
DATA_DIR = SERVER_DIR / "data"
DB_PATH = DATA_DIR / "estu-portable.sqlite"
SCHEMA_PATH = SERVER_DIR / "portable_schema.sql"
SEED_PATH = ROOT / "data" / "portable-seed.json"
PASSWORD_ITERATIONS = 120_000
SESSION_HOURS = 12
ALLOWED_MODULES = ("journal", "navigation", "navcontrol", "fleet", "bso", "users", "shifts", "warehouse")
# Legacy identifier retained for the existing master and shift profile contract.
TO_DEPARTMENT = "Участок заявочных ремонтов"
LEGACY_TO_DEPARTMENT = "Участок технического обслуживания"


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def today_iso() -> str:
    return date.today().isoformat()


def parse_iso_date(value: Any, fallback: date | None = None) -> date:
    if value:
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            pass
    if fallback is not None:
        return fallback
    raise ApiError(400, "Некорректная дата.")


def text(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    return str(value).strip()


def required(value: Any, field: str) -> str:
    result = text(value)
    if not result:
        raise ApiError(400, f"Заполните поле «{field}».")
    return result


def json_load(value: Any, fallback: Any) -> Any:
    if value is None or value == "":
        return fallback
    try:
        return json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return fallback


def board_sort_key(board: Any) -> tuple[int, int | str, str]:
    value = str(board or "")
    try:
        return (0, int(value), value)
    except ValueError:
        return (1, value.casefold(), value)


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.execute("COMMIT")
    except Exception:
        try:
            connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        connection.close()


def row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def default_modules(role: str) -> list[str]:
    if role == "admin":
        return list(ALLOWED_MODULES)
    if role == "manager":
        return ["journal", "fleet", "shifts"]
    return ["journal", "navigation", "navcontrol", "fleet", "bso"]


def default_permissions(role: str, scope: str | None = None) -> dict[str, bool]:
    return {
        "viewAllRequests": role == "admin" or (role == "manager" and scope != "master"),
        "createRequests": True,
        "editRequests": True,
        "reassignRequests": role in ("admin", "manager"),
        "completeRequests": scope != "management",
        "deleteRequests": role == "admin",
        "manageFleet": role == "admin",
        "manageNavigation": role in ("admin", "executor"),
        "manageNavControl": role in ("admin", "executor"),
        "configureNavMail": role == "admin",
        "manageBso": role in ("admin", "executor"),
        "manageHistory": role == "admin",
        "manageUsers": role == "admin",
        "viewAudit": role == "admin",
        "manageShifts": role == "admin" or scope == "management",
    }


def access_scope_for_role(role: str) -> str:
    return {"admin": "admin", "manager": "master"}.get(role, "rel")


def role_for_scope(scope: str) -> str:
    try:
        return {"admin": "admin", "management": "manager", "master": "manager", "rel": "executor", "warehouse": "executor"}[scope]
    except KeyError as exc:
        raise ApiError(400, "Неизвестный блок входа.") from exc


def modules_for_user(user: dict[str, Any] | sqlite3.Row) -> list[str]:
    if user["access_scope"] == "warehouse":
        return ["warehouse"]
    role = str(user["role"])
    if role == "admin":
        return default_modules(role)
    parsed = json_load(user["modules_json"], default_modules(role))
    return list(dict.fromkeys([*(item for item in parsed if item in ALLOWED_MODULES), "warehouse"]))


def permissions_for_user(user: dict[str, Any] | sqlite3.Row) -> dict[str, bool]:
    scope = user["access_scope"] if "access_scope" in user.keys() else None
    result = default_permissions(str(user["role"]), scope)
    if scope == "warehouse":
        return {key: False for key in result}
    custom = json_load(user["permissions_json"], {})
    if isinstance(custom, dict):
        for key in result:
            if key in custom:
                result[key] = bool(custom[key])
    if scope == "master":
        result["viewAllRequests"] = False
    return result


def public_user(user: dict[str, Any] | sqlite3.Row | None) -> dict[str, Any] | None:
    if user is None:
        return None
    return {
        "id": str(user["id"]),
        "username": str(user["username"]),
        "displayName": str(user["display_name"]),
        "role": str(user["role"]),
        "accessScope": user["access_scope"] or access_scope_for_role(str(user["role"])),
        "department": user["department"],
        "shiftId": user["shift_id"] if "shift_id" in user.keys() else None,
        "modules": modules_for_user(user),
        "permissions": permissions_for_user(user),
        "isActive": bool(user["is_active"]),
    }


def assert_permission(user: dict[str, Any] | sqlite3.Row, permission: str) -> None:
    if not permissions_for_user(user).get(permission, False):
        raise ApiError(403, "Недостаточно прав для этого действия.")


def assert_module(user: dict[str, Any] | sqlite3.Row, module: str) -> None:
    if module not in modules_for_user(user):
        raise ApiError(403, "Нет доступа к выбранной системе.")


def assert_department(user: dict[str, Any] | sqlite3.Row, department: str) -> None:
    if permissions_for_user(user).get("viewAllRequests"):
        return
    if str(user["department"] or "") != department:
        raise ApiError(403, "Заявка относится к другому подразделению.")


def password_digest(password: str, salt: bytes, iterations: int = PASSWORD_ITERATIONS) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


def verify_password(user: dict[str, Any] | sqlite3.Row, password: str) -> bool:
    expected = bytes(user["password_hash"])
    actual = password_digest(password, bytes(user["password_salt"]), int(user["password_iterations"]))
    return secrets.compare_digest(expected, actual)


def set_password(connection: sqlite3.Connection, user_id: str, password: str) -> None:
    if len(password) < 4:
        raise ApiError(400, "Пароль должен содержать не менее 4 символов.")
    salt = secrets.token_bytes(16)
    digest = password_digest(password, salt)
    connection.execute(
        "UPDATE users SET password_hash=?, password_salt=?, password_iterations=?, updated_at=? WHERE id=?",
        (digest, salt, PASSWORD_ITERATIONS, now_iso(), user_id),
    )


def create_session(connection: sqlite3.Connection, user_id: str) -> str:
    connection.execute("DELETE FROM user_sessions WHERE expires_at<=?", (now_iso(),))
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = datetime.now().replace(microsecond=0)
    connection.execute(
        "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)",
        (token_hash, user_id, now.isoformat(), (now + timedelta(hours=SESSION_HOURS)).isoformat(), now.isoformat()),
    )
    return token


def current_user(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with connect() as connection:
        row = connection.execute(
            """
            SELECT u.* FROM user_sessions s
            JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1
            """,
            (token_hash, now_iso()),
        ).fetchone()
        if row is None:
            return None
        connection.execute("UPDATE user_sessions SET last_seen_at=? WHERE token_hash=?", (now_iso(), token_hash))
        return dict(row)


def write_audit(
    connection: sqlite3.Connection,
    user: dict[str, Any] | sqlite3.Row | None,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    details: Any = None,
) -> None:
    connection.execute(
        "INSERT INTO audit_log(user_id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)",
        (
            user["id"] if user else None,
            user["display_name"] if user else "Система",
            action,
            entity_type,
            entity_id,
            json.dumps(details, ensure_ascii=False, separators=(",", ":")) if details is not None else None,
            now_iso(),
        ),
    )


def _decode_seed_value(value: Any) -> Any:
    if isinstance(value, dict) and "$base64" in value:
        return base64.b64decode(value["$base64"])
    return value


def seed_from_file(connection: sqlite3.Connection) -> None:
    if not SEED_PATH.exists():
        return
    seed = json.loads(SEED_PATH.read_text(encoding="utf-8-sig"))
    tables = seed.get("tables", {})
    for table, rows in tables.items():
        if not rows:
            continue
        columns = list(rows[0].keys())
        marks = ",".join("?" for _ in columns)
        names = ",".join(f'"{name}"' for name in columns)
        sql = f'INSERT OR IGNORE INTO "{table}"({names}) VALUES({marks})'
        for row in rows:
            connection.execute(sql, tuple(_decode_seed_value(row.get(column)) for column in columns))


def initialize_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    first_start = not DB_PATH.exists()
    connection = connect()
    try:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        rename_pending = bool(columns and connection.execute(
            "SELECT 1 FROM departments WHERE name=?", (LEGACY_TO_DEPARTMENT,)
        ).fetchone() and connection.execute(
            "SELECT 1 FROM app_meta WHERE key='repair_department_name_v1'"
        ).fetchone() is None)
        if columns and ("shift_id" not in columns or rename_pending):
            backup_dir = DATA_DIR / "migration-backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            target = sqlite3.connect(backup_dir / f"before-shifts-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.sqlite")
            try:
                connection.backup(target)
            finally:
                target.close()
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        from portable_workflow import SCHEMA as FLOW_SCHEMA
        connection.executescript(FLOW_SCHEMA)
        if first_start and SEED_PATH.exists():
            seed_tables = json.loads(SEED_PATH.read_text(encoding="utf-8-sig")).get("tables", {})
            if "stock_items" in seed_tables:
                from portable_stock import SCHEMA as STOCK_SCHEMA
                connection.executescript(STOCK_SCHEMA)
        connection.execute("BEGIN IMMEDIATE")
        try:
            if "shift_id" not in {row["name"] for row in connection.execute("PRAGMA table_info(users)")}:
                connection.execute("ALTER TABLE users ADD COLUMN shift_id TEXT REFERENCES work_shifts(id)")
            if first_start:
                seed_from_file(connection)
                connection.execute(
                    "INSERT OR REPLACE INTO app_meta(key,value) VALUES('created_at',?)", (now_iso(),)
                )
            if connection.execute("SELECT 1 FROM app_meta WHERE key='repair_department_name_v1'").fetchone() is None:
                old = connection.execute("SELECT 1 FROM departments WHERE name=?", (LEGACY_TO_DEPARTMENT,)).fetchone()
                if old:
                    connection.execute("INSERT OR IGNORE INTO departments(name,sort_order) VALUES(?,20)", (TO_DEPARTMENT,))
                    for table in ("users", "requests", "repair_history", "stock_orders", "stock_movements"):
                        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                            connection.execute(f"UPDATE {table} SET department=? WHERE department=?", (TO_DEPARTMENT, LEGACY_TO_DEPARTMENT))
                    connection.execute("DELETE FROM departments WHERE name=?", (LEGACY_TO_DEPARTMENT,))
                for row in connection.execute("SELECT id,display_name FROM users WHERE access_scope='master'").fetchall():
                    if row["display_name"].startswith(LEGACY_TO_DEPARTMENT):
                        display = TO_DEPARTMENT + row["display_name"][len(LEGACY_TO_DEPARTMENT):]
                        connection.execute("UPDATE users SET display_name=? WHERE id=?", (display,row["id"]))
                connection.execute("INSERT INTO app_meta(key,value) VALUES('repair_department_name_v1',?)", (now_iso(),))
            if connection.execute("SELECT 1 FROM app_meta WHERE key='shift_profiles_v1'").fetchone() is None:
                connection.execute("INSERT OR IGNORE INTO departments(name,sort_order) VALUES(?,20)", (TO_DEPARTMENT,))
                for row in connection.execute("SELECT * FROM users WHERE access_scope='master'").fetchall():
                    modules = json_load(row["modules_json"], default_modules("manager"))
                    if not isinstance(modules, list):
                        modules = default_modules("manager")
                    modules = list(dict.fromkeys([*modules, "shifts"]))
                    display = TO_DEPARTMENT if row["display_name"] in ("Мастер цеха", "Начальник цеха") else row["display_name"]
                    connection.execute("UPDATE users SET department=?,modules_json=?,display_name=? WHERE id=?",
                                       (TO_DEPARTMENT, json.dumps(modules, ensure_ascii=False), display, row["id"]))
                connection.execute("INSERT INTO app_meta(key,value) VALUES('shift_profiles_v1',?)", (now_iso(),))
            connection.execute("INSERT OR IGNORE INTO app_meta(key,value) VALUES('to_shift_schedule',?)",
                               (json.dumps({"anchorDate":"2026-10-01","dayStart":"08:00","nightStart":"20:00"}),))
            connection.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES('schema_version','2')")
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
    finally:
        connection.close()


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes) -> tuple[DataBlob, Any]:
    buffer = ctypes.create_string_buffer(data)
    return DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def protect_secret(value: str) -> str:
    if not value:
        return ""
    if os.name != "nt":
        return base64.b64encode(value.encode("utf-8")).decode("ascii")
    source, source_buffer = _blob(value.encode("utf-8"))
    target = DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)
    ):
        raise ctypes.WinError()
    try:
        raw = ctypes.string_at(target.pbData, target.cbData)
        return base64.b64encode(raw).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(target.pbData)
        del source_buffer


def unprotect_secret(value: str) -> str:
    if not value:
        return ""
    raw = base64.b64decode(value)
    if os.name != "nt":
        return raw.decode("utf-8")
    source, source_buffer = _blob(raw)
    target = DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)
    ):
        return ""
    try:
        return ctypes.string_at(target.pbData, target.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(target.pbData)
        del source_buffer


def new_id() -> str:
    return str(uuid.uuid4())
