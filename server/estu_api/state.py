"""HTTP endpoints for state."""

from portable_core import ApiError
from estu_services.snapshot import get_state


def handle(handler, method, path, query, user=None, local=False):
    if method == 'GET' and path == '/api/state':
        history = query.get('history', ['1'])[0] != '0'
        navigation = query.get('navigation', ['1'])[0] != '0'
        return handler._json(get_state(user, history, navigation))
    raise ApiError(404, 'Маршрут не найден.')
