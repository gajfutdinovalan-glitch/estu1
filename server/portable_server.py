"""Portable launcher, HTTP transport and background tasks."""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import sys
import threading
import traceback
import urllib.parse
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from portable_core import ApiError, DB_PATH, ROOT, SESSION_HOURS, current_user, initialize_database, now_iso
from portable_yandex import worker as yandex_worker
import portable_stock as stock
from estu_api import dispatch as dispatch_api
from estu_api.constants import COOKIE_NAME


PID_PATH=Path(__file__).resolve().parent/"data"/"portable-server.pid"
LOG_PATH=Path(__file__).resolve().parent/"data"/"portable-server.log"
BACKUP_DIR=ROOT/"backups"/"portable"
STOP_EVENT=threading.Event()


class EstuServer(ThreadingHTTPServer):
    daemon_threads=True
    allow_reuse_address=True


class Handler(BaseHTTPRequestHandler):
    server_version="ESTU-Portable/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        LOG_PATH.parent.mkdir(parents=True,exist_ok=True)
        with LOG_PATH.open("a",encoding="utf-8") as log:
            log.write(f"{now_iso()} {self.client_address[0]} {fmt % args}\n")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("X-Frame-Options","SAMEORIGIN")
        super().end_headers()

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _path(self) -> tuple[str,dict[str,list[str]]]:
        parsed=urllib.parse.urlsplit(self.path)
        return urllib.parse.unquote(parsed.path),urllib.parse.parse_qs(parsed.query)

    def _body(self) -> dict[str,Any]:
        length=int(self.headers.get("Content-Length") or 0)
        if length<=0:return {}
        if length>30*1024*1024:raise ApiError(413,"Запрос слишком большой.")
        try:return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError,json.JSONDecodeError) as exc:raise ApiError(400,"Некорректный JSON-запрос.") from exc

    def _token(self) -> str | None:
        cookie=SimpleCookie();cookie.load(self.headers.get("Cookie") or "")
        return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None

    def _user(self) -> dict[str,Any]:
        user=current_user(self._token())
        if user is None:raise ApiError(401,"Требуется вход в систему.")
        return user

    def _json(self,value:Any,status:int=200,extra_headers:dict[str,str]|None=None) -> None:
        data=json.dumps(value,ensure_ascii=False,separators=(",",":"),default=str).encode("utf-8")
        self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store");self.send_header("Content-Length",str(len(data)))
        for key,val in (extra_headers or {}).items():self.send_header(key,val)
        self.end_headers();self.wfile.write(data)

    def _empty(self,status:int=204,extra_headers:dict[str,str]|None=None) -> None:
        self.send_response(status);self.send_header("Cache-Control","no-store")
        for key,val in (extra_headers or {}).items():self.send_header(key,val)
        self.end_headers()

    def _cookie_header(self,token:str) -> str:
        return f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_HOURS*3600}"

    def _download(self,path:Path) -> None:
        data=path.read_bytes();name=urllib.parse.quote(path.name)
        self.send_response(200);self.send_header("Content-Type","application/zip")
        self.send_header("Content-Disposition",f"attachment; filename*=UTF-8''{name}")
        self.send_header("Content-Length",str(len(data)));self.send_header("Cache-Control","no-store")
        self.end_headers();self.wfile.write(data)

    def _dispatch(self,method:str) -> None:
        try:
            path,query=self._path()
            if not path.startswith("/api/"):
                if method!="GET":raise ApiError(405,"Метод не поддерживается.")
                return self._static(path)
            self._api(method,path,query)
        except ApiError as exc:self._json({"error":exc.message},exc.status)
        except sqlite3.IntegrityError as exc:
            self.log_error("SQLite integrity: %s",exc);self._json({"error":"Не удалось сохранить данные: нарушена уникальность или связь записей."},409)
        except BrokenPipeError:pass
        except Exception as exc:
            self.log_error("Unhandled: %s\n%s",exc,traceback.format_exc());self._json({"error":"Внутренняя ошибка переносимого сервера."},500)

    def _static(self, path: str) -> None:
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        root = ROOT.resolve()
        target = (root / relative).resolve()
        if not target.is_relative_to(root):
            raise ApiError(403, "Доступ запрещён.")

        public_path = target.relative_to(root)
        # The web root is deliberately smaller than the portable distribution.
        if public_path.as_posix() != "index.html" and public_path.parts[:1] not in (("frontend",), ("assets",)):
            raise ApiError(404, "Файл не найден.")
        if not target.is_file():
            raise ApiError(404, "Файл не найден.")

        data = target.read_bytes()
        mime = "application/javascript" if target.suffix == ".js" else mimetypes.guess_type(target.name)[0]
        mime = mime or "application/octet-stream"
        charset = "; charset=utf-8" if mime.startswith("text/") or mime in ("application/javascript", "application/json") else ""
        self.send_response(200)
        self.send_header("Content-Type", mime + charset)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        dispatch_api(self, method, path, query)


def backup_worker() -> None:
    while not STOP_EVENT.is_set():
        try:
            BACKUP_DIR.mkdir(parents=True,exist_ok=True)
            destination=BACKUP_DIR/f"estu-{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.sqlite"
            source=sqlite3.connect(DB_PATH,timeout=15);target=sqlite3.connect(destination)
            try:source.backup(target)
            finally:target.close();source.close()
            files=sorted(BACKUP_DIR.glob("estu-*.sqlite"),key=lambda path:path.stat().st_mtime,reverse=True)
            for old in files[35:]:old.unlink(missing_ok=True)
        except Exception:pass
        STOP_EVENT.wait(24*3600)


def main() -> None:
    parser=argparse.ArgumentParser();parser.add_argument("--port",type=int,default=8080);args=parser.parse_args()
    initialize_database();stock.initialize_stock();PID_PATH.parent.mkdir(parents=True,exist_ok=True);PID_PATH.write_text(str(os.getpid()),encoding="ascii")
    threading.Thread(target=backup_worker,name="backup",daemon=True).start()
    threading.Thread(target=yandex_worker,args=(STOP_EVENT,),name="yandex",daemon=True).start()
    server=EstuServer(("127.0.0.1",args.port),Handler)
    try:server.serve_forever(poll_interval=.5)
    finally:
        STOP_EVENT.set();server.server_close();PID_PATH.unlink(missing_ok=True)


if __name__=="__main__":main()
