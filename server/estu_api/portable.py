"""HTTP endpoints for portable."""

import threading
from portable_core import ApiError
from portable_export import create_export


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/portable/export' and method == 'GET':
        if user['role'] != 'admin':
            raise ApiError(403, 'Выгрузка доступна только администратору.')
        return handler._download(create_export())
    if path == '/api/portable/shutdown' and method == 'POST':
        if user['role'] != 'admin' or not local:
            raise ApiError(403, 'Остановка доступна только локальному администратору.')
        handler._empty()
        threading.Thread(target=handler.server.shutdown, daemon=True).start()
        return
    raise ApiError(404, 'Маршрут не найден.')
