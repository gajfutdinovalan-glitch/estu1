"""HTTP endpoints for navigation."""

import re
import urllib.parse
from portable_core import ApiError
from estu_services.navigation import get_navigation, save_navigation, import_navigation


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/navigation/import-local' and method == 'POST':
        return handler._json({'imported': import_navigation(handler._body(), user)})
    match = re.fullmatch('/api/navigation/([^/]+)', path)
    if match:
        board = urllib.parse.unquote(match.group(1))
        if method == 'GET':
            result = get_navigation(board, user)
            if result is None:
                raise ApiError(404, 'Запись не найдена.')
            return handler._json(result)
        if method == 'PUT':
            return handler._json(save_navigation(board, handler._body(), user))
    raise ApiError(404, 'Маршрут не найден.')
