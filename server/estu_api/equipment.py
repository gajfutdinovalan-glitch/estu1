"""HTTP endpoints for equipment."""

import re
import urllib.parse
from portable_core import ApiError
from estu_services.equipment import get_bso, save_bso_records, bso_history


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/bso' and method == 'GET':
        return handler._json(get_bso(user))
    if path == '/api/bso/history' and method == 'GET':
        return handler._json(bso_history(user))
    if path == '/api/bso/import' and method == 'POST':
        return handler._json({'imported': save_bso_records(handler._body().get('records') or [], user, True)})
    match = re.fullmatch('/api/bso/([^/]+)', path)
    if match:
        board = urllib.parse.unquote(match.group(1))
        if method == 'PUT':
            save_bso_records([{**handler._body(), 'board': board}], user, False)
            return handler._empty()
        if method == 'DELETE':
            save_bso_records([{'board': board}], user, False)
            return handler._empty()
    raise ApiError(404, 'Маршрут не найден.')
