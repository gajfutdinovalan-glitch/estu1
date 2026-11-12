from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from portable_core import DATA_DIR, DB_PATH, ROOT, connect, initialize_database, now_iso


EXPORT_DIR = ROOT / "Exports"
EXPORT_TABLES = (
    "app_meta", "departments", "work_shifts", "users", "fleet", "requests", "repair_history", "navigation_equipment",
    "bso_board_notes", "bso_devices", "audit_log", "yandex_checkpoints", "nav_reports",
    "nav_observations", "nav_mail_config", "nav_mail_state", "nav_sync_log", "nav_attention_cases",
    "stock_items", "stock_serials", "stock_orders", "stock_movements", "stock_purchases",
    "request_flow", "request_events",
    "request_note_meta",
)


def _json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"$base64": base64.b64encode(value).decode("ascii")}
    return value


def _logical_export() -> dict[str, Any]:
    with connect() as connection:
        tables: dict[str, list[dict[str, Any]]] = {}
        for table in EXPORT_TABLES:
            rows=[]
            for row in connection.execute(f'SELECT * FROM "{table}"'):
                item={key:_json_value(row[key]) for key in row.keys()}
                if table=="nav_mail_config":
                    item["password_protected"]=""
                    item["auto_sync"]=0
                rows.append(item)
            tables[table]=rows
        schema=connection.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()
        return {"format":"ESTU-portable-export","formatVersion":1,"schemaVersion":schema[0] if schema else "1",
                "exportedAt":now_iso(),"tables":tables}


def create_export(destination: Path | None = None) -> Path:
    initialize_database()
    from portable_stock import initialize_stock
    initialize_stock()
    EXPORT_DIR.mkdir(parents=True,exist_ok=True)
    timestamp=datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    destination=destination or EXPORT_DIR/f"ESTU-Test-{timestamp}.zip"
    with tempfile.TemporaryDirectory(prefix="estu-export-") as temp_name:
        temp=Path(temp_name); snapshot=temp/"estu-portable.sqlite"
        source=sqlite3.connect(DB_PATH,timeout=15)
        target=sqlite3.connect(snapshot)
        try: source.backup(target)
        finally: target.close();source.close()
        logical=temp/"data-export.json"
        logical.write_text(json.dumps(_logical_export(),ensure_ascii=False,indent=2),encoding="utf-8")
        checksums={path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in (snapshot,logical)}
        manifest={"product":"ЕСТУ, переносимая тестовая сборка","createdAt":now_iso(),"formatVersion":1,
                  "files":checksums,"sourceInstance":str(DB_PATH.resolve())}
        manifest_path=temp/"manifest.json"
        manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
        with zipfile.ZipFile(destination,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
            for path in (snapshot,logical,manifest_path): archive.write(path,path.name)
    return destination


if __name__=="__main__":
    path=create_export(Path(sys.argv[1]).resolve() if len(sys.argv)>1 else None)
    print(path)
