"""HTTP endpoints for nav control."""

import re
from portable_core import ApiError
from portable_navcontrol import attention_action, attention_history, dashboard, dismiss_attention, import_workbook, mail_public, request_mail_sync, save_mail


def handle(handler, method, path, query, user=None, local=False):
    match = re.fullmatch('/api/nav-control/attention/([^/]+)/history', path)
    if match and method == 'GET':
        result = attention_history(match.group(1), user)
        if result is None:
            raise ApiError(404, 'Карточка не найдена.')
        return handler._json(result)
    match = re.fullmatch('/api/nav-control/attention/([^/]+)/(note|complete|dismiss)', path)
    if match and method == 'POST':
        if match.group(2) == 'dismiss':
            result = dismiss_attention(match.group(1), handler._body(), user)
        else:
            result = attention_action(match.group(1), handler._body(), user, 'measure' if match.group(2) == 'complete' else 'note')
        if not result:
            raise ApiError(404, 'Карточка не найдена или уже закрыта.')
        return handler._json(result)
    if path == '/api/nav-control':
        if method == 'GET':
            return handler._json(dashboard(query.get('from', [''])[0], query.get('to', [''])[0], user))
    if path == '/api/nav-control/import' and method == 'POST':
        return handler._json(import_workbook(handler._body(), user))
    if path == '/api/nav-control/settings':
        if method == 'GET':
            return handler._json(mail_public(user))
        if method == 'PUT':
            return handler._json(save_mail(handler._body(), user))
    if path == '/api/nav-control/sync' and method == 'POST':
        request_mail_sync(user)
        return handler._empty()
    raise ApiError(404, 'Маршрут не найден.')
