"""HTTP endpoints for auth public."""

import time
from portable_core import ApiError, connect, create_session, current_user, now_iso, public_user, required, text, transaction, verify_password, write_audit, role_for_scope
from portable_users import create_user
from portable_shifts import public_schedule, validate_shift


def handle(handler, method, path, query, user=None, local=False):
    if method == 'GET' and path == '/api/auth/status':
        with connect() as connection:
            count = connection.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        user = current_user(handler._token())
        return handler._json({'portable': True, 'setupRequired': count == 0, 'setupAllowed': count == 0 and local, 'authenticated': user is not None, 'user': public_user(user), 'shiftSchedule': public_schedule()})
    if method == 'POST' and path == '/api/auth/setup':
        if not local:
            raise ApiError(403, 'Первого администратора можно создать только на серверном компьютере.')
        with connect() as connection:
            if connection.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
                raise ApiError(409, 'Первый администратор уже создан.')
        created = create_user(handler._body(), None, 'admin')
        with transaction() as connection:
            token = create_session(connection, created['id'])
        return handler._json({'user': created}, 201, {'Set-Cookie': handler._cookie_header(token)})
    if method == 'POST' and path in ('/api/auth/login', '/api/auth/block-login'):
        body = handler._body()
        password = required(body.get('password'), 'Пароль')
        with transaction() as connection:
            if path.endswith('block-login'):
                scope = required(body.get('scope'), 'Блок входа')
                if scope in ('pto', 'maintenance'):
                    raise ApiError(501, 'Этот участок ещё в разработке.')
                role_for_scope(scope)
                if scope == 'master':
                    shift_id = validate_shift(scope, body.get('shiftId'), True)
                    rows = connection.execute('SELECT * FROM users WHERE is_active=1 AND access_scope=? AND shift_id IS ? ORDER BY display_name', (scope, shift_id)).fetchall()
                else:
                    rows = connection.execute('SELECT * FROM users WHERE is_active=1 AND access_scope=? ORDER BY last_login_at DESC,display_name', (scope,)).fetchall()
            else:
                username = text(body.get('username')).lower()
                rows = connection.execute('SELECT * FROM users WHERE username=? AND is_active=1', (username,)).fetchall()
            matches = [dict(row) for row in rows if verify_password(row, password)]
            if len(matches) > 1:
                raise ApiError(409, 'Пароль подходит нескольким профилям. Администратору нужно назначить им разные пароли.')
            matched = matches[0] if matches else None
            if matched is None:
                time.sleep(0.35)
                raise ApiError(401, 'Неверный пароль для выбранного блока.' if rows else 'Для выбранного блока ещё не создан активный профиль.')
            connection.execute('UPDATE users SET last_login_at=? WHERE id=?', (now_iso(), matched['id']))
            token = create_session(connection, matched['id'])
            write_audit(connection, matched, 'login', 'session', None, {'scope': matched.get('access_scope')})
        return handler._json({'user': public_user(matched)}, 200, {'Set-Cookie': handler._cookie_header(token)})
    raise ApiError(404, 'Маршрут не найден.')
