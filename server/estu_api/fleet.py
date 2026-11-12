"""HTTP endpoints for fleet."""

import re
import urllib.parse
from portable_core import ApiError
from estu_services.fleet import add_fleet, update_fleet, remove_fleet


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/fleet' and method == 'POST':
        add_fleet(handler._body(), user)
        return handler._empty(201)
    match = re.fullmatch('/api/fleet/([^/]+)', path)
    if match:
        board = urllib.parse.unquote(match.group(1))
        if method == 'PUT':
            update_fleet(board, handler._body(), user)
            return handler._empty()
        if method == 'DELETE':
            remove_fleet(board, user)
            return handler._empty()
    raise ApiError(404, 'Маршрут не найден.')
