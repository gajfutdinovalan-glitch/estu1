"""HTTP endpoints for stock."""

import re
from portable_core import ApiError
import portable_stock as stock


def handle(handler, method, path, query, user=None, local=False):
    if path == '/api/stock' and method == 'GET':
        return handler._json(stock.data(user))
    if path == '/api/stock/items' and method == 'POST':
        return handler._json(stock.save_item(handler._body(), user), 201)
    if path == '/api/stock/catalog' and method == 'POST':
        return handler._json(stock.seed_catalog(user))
    if path == '/api/stock/receipts' and method == 'POST':
        return handler._json(stock.receipt(handler._body(), user), 201)
    if path == '/api/stock/orders' and method == 'POST':
        return handler._json(stock.create_order(handler._body(), user), 201)
    match = re.fullmatch('/api/stock/orders/([^/]+)', path)
    if match and method == 'POST':
        return handler._json(stock.order_action(match.group(1), handler._body(), user))
    if path == '/api/stock/purchases' and method == 'POST':
        return handler._json(stock.purchase(handler._body(), user), 201)
    match = re.fullmatch('/api/stock/purchases/([^/]+)', path)
    if match and method == 'POST':
        return handler._json(stock.purchase_action(match.group(1), handler._body(), user))
    raise ApiError(404, 'Маршрут не найден.')
