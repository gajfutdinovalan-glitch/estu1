"""HTTP endpoints for auth session."""

import hashlib
from portable_core import ApiError, public_user, transaction, write_audit
from estu_api.constants import COOKIE_NAME


def handle(handler, method, path, query, user=None, local=False):
    if method == 'POST' and path == '/api/auth/logout':
        token = handler._token()
        with transaction() as connection:
            if token:
                connection.execute('DELETE FROM user_sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
            write_audit(connection, user, 'logout', 'session')
        return handler._empty(extra_headers={'Set-Cookie': f'{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'})
    if method == 'GET' and path == '/api/auth/me':
        return handler._json({'user': public_user(user)})
    raise ApiError(404, 'Маршрут не найден.')
