"""Route requests after applying the existing session boundary."""
from portable_core import ApiError

from . import (
    auth_public, auth_session, equipment, fleet, history, mail_worker, nav_control,
    navigation, portable, requests, shifts, state, stock, users,
)

ROUTES = {
    "auth": auth_session, "stock": stock, "state": state, "shifts": shifts,
    "users": users, "audit": users, "nav-control": nav_control,
    "navigation": navigation, "bso": equipment, "requests": requests,
    "history": history, "fleet": fleet, "portable": portable,
}


def dispatch(handler, method, path, query):
    local = handler.client_address[0] in ("127.0.0.1", "::1")
    if (method, path) in {
        ("GET", "/api/auth/status"), ("POST", "/api/auth/setup"),
        ("POST", "/api/auth/login"), ("POST", "/api/auth/block-login"),
    }:
        return auth_public.handle(handler, method, path, query, local=local)
    if path.startswith("/api/nav-control/worker/"):
        if not local or (method == "GET" and path.endswith("/config")) or (
            method == "POST" and path.endswith(("/import", "/state"))
        ):
            return mail_worker.handle(handler, method, path, query, local=local)
    user = handler._user()
    area = path.removeprefix("/api/").split("/", 1)[0]
    route = ROUTES.get(area)
    if route is None:
        raise ApiError(404, "Маршрут не найден.")
    return route.handle(handler, method, path, query, user=user, local=local)
