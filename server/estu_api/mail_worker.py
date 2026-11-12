"""HTTP endpoints for mail worker."""

from portable_core import ApiError
from portable_navcontrol import import_workbook, worker_config, worker_state


def handle(handler, method, path, query, user=None, local=False):
    if path.startswith('/api/nav-control/worker/'):
        if not local:
            raise ApiError(403, 'Служебный маршрут доступен только локально.')
        if method == 'GET' and path.endswith('/config'):
            return handler._json(worker_config())
        if method == 'POST' and path.endswith('/import'):
            return handler._json(import_workbook(handler._body(), None, True))
        if method == 'POST' and path.endswith('/state'):
            worker_state(handler._body())
            return handler._empty()
    raise ApiError(404, 'Маршрут не найден.')
