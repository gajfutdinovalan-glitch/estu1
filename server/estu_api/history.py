"""HTTP endpoints for history."""

import re
from portable_core import ApiError
from estu_services.history import update_history, delete_history


def handle(handler, method, path, query, user=None, local=False):
    match = re.fullmatch('/api/history/([^/]+)', path)
    if match:
        if method == 'PUT':
            result = update_history(match.group(1), handler._body(), user)
            if result is None:
                raise ApiError(404, 'Запись истории не найдена.')
            return handler._json(result)
        if method == 'DELETE':
            if not delete_history(match.group(1), user):
                raise ApiError(404, 'Запись истории не найдена.')
            return handler._empty()
    raise ApiError(404, 'Маршрут не найден.')
