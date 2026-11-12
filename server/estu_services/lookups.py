"""Lookups application service."""
from __future__ import annotations

import sqlite3
from typing import Any
from portable_core import ApiError, text


def model_for_board(connection: sqlite3.Connection, board: str, active: bool = True) -> str:
    query = "SELECT model FROM fleet WHERE board=?"
    parameters: list[Any] = [board]
    if active:
        query += " AND is_active=1"
    row = connection.execute(query, parameters).fetchone()
    if row is None:
        raise ApiError(400, "Борт не найден в активном парке.")
    return str(row["model"])


def department_exists(connection: sqlite3.Connection, department: str) -> bool:
    return connection.execute("SELECT 1 FROM departments WHERE name=?", (department,)).fetchone() is not None


def default_department(connection: sqlite3.Connection, user: dict[str, Any]) -> str:
    preferred = text(user.get("department"))
    if preferred and department_exists(connection, preferred):
        return preferred
    for candidate in ("Электронщики", "Электроучасток", "УЗР"):
        if department_exists(connection, candidate):
            return candidate
    row = connection.execute("SELECT name FROM departments ORDER BY sort_order,name LIMIT 1").fetchone()
    if row is None:
        raise ApiError(400, "В базе нет подразделений для привязки участка.")
    return str(row["name"])
