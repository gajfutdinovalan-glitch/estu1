"""HTTP endpoints for users."""

import re
from portable_core import ApiError
from portable_users import audit_log, create_user, delete_user, list_users, reset_password, update_user


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/users':
        if method == 'GET':
            return handler._json(list_users(user))
        if method == 'POST':
            return handler._json(create_user(handler._body(), user), 201)
    match = re.fullmatch('/api/users/([^/]+)/password', path)
    if match and method == 'POST':
        if not reset_password(match.group(1), handler._body(), user):
            raise ApiError(404, 'Профиль не найден.')
        return handler._empty()
    match = re.fullmatch('/api/users/([^/]+)', path)
    if match:
        if method == 'PUT':
            result = update_user(match.group(1), handler._body(), user)
            if result is None:
                raise ApiError(404, 'Профиль не найден.')
            return handler._json(result)
        if method == 'DELETE':
            if not delete_user(match.group(1), user):
                raise ApiError(404, 'Профиль не найден.')
            return handler._empty()
    if method == 'GET' and path == '/api/audit':
        return handler._json(audit_log(user))
    raise ApiError(404, 'Маршрут не найден.')
