"""HTTP endpoints for shifts."""

from portable_core import ApiError
from portable_shifts import get_schedule, save_schedule


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/shifts':
        if method == 'GET':
            return handler._json(get_schedule(user, query.get('from', [''])[0], query.get('days', ['14'])[0]))
        if method == 'PUT':
            return handler._json(save_schedule(handler._body(), user))
    raise ApiError(404, 'Маршрут не найден.')
