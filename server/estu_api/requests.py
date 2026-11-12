"""HTTP endpoints for requests."""

import re
from portable_core import ApiError
import portable_workflow as workflow
from estu_services.requests import add_request, update_request, delete_request, complete_request


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/requests' and method == 'POST':
        return handler._json(add_request(handler._body(), user), 201)
    match = re.fullmatch('/api/requests/([^/]+)/notes/([^/]+)', path)
    if match and method == 'DELETE':
        return handler._json(workflow.delete_note(match.group(1), match.group(2), handler._body(), user))
    match = re.fullmatch('/api/requests/([^/]+)/decision', path)
    if match and method == 'POST':
        return handler._json(workflow.decide(match.group(1), handler._body(), user))
    match = re.fullmatch('/api/requests/([^/]+)/complete', path)
    if match and method == 'POST':
        result = complete_request(match.group(1), handler._body(), user)
        if result is None:
            raise ApiError(404, 'Заявка не найдена.')
        return handler._json(result)
    match = re.fullmatch('/api/requests/([^/]+)', path)
    if match:
        if method == 'PUT':
            result = update_request(match.group(1), handler._body(), user)
            if result is None:
                raise ApiError(404, 'Заявка не найдена.')
            return handler._json(result)
        if method == 'DELETE':
            if not delete_request(match.group(1), user):
                raise ApiError(404, 'Заявка не найдена.')
            return handler._empty()
    raise ApiError(404, 'Маршрут не найден.')
