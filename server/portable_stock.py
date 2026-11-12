from __future__ import annotations

import json
from contextlib import closing
from decimal import Decimal, InvalidOperation
from portable_core import ApiError, connect, transaction, new_id, now_iso, required, text, write_audit, assert_department, TO_DEPARTMENT
import portable_workflow as workflow

SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_items(
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL CHECK(unit IN ('шт','м','л','кг')),
 policy TEXT NOT NULL CHECK(policy IN ('free','repair','serial')),
 minimum INTEGER NOT NULL DEFAULT 0 CHECK(minimum>=0), balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0));
CREATE TABLE IF NOT EXISTS stock_serials(
 item_id TEXT NOT NULL REFERENCES stock_items(id), number TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'stock' CHECK(state IN ('stock','issued')), PRIMARY KEY(item_id,number));
CREATE TABLE IF NOT EXISTS stock_orders(
 id TEXT PRIMARY KEY, repair_id TEXT, board TEXT NOT NULL, department TEXT NOT NULL, shift_id TEXT,
 repair_description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','collected','issued','cancelled')),
 lines TEXT NOT NULL, note TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, recipient TEXT, issued_at TEXT);
CREATE TABLE IF NOT EXISTS stock_movements(
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES stock_items(id), quantity INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('receipt','issue')), serials TEXT NOT NULL, order_id TEXT,
 board TEXT, department TEXT, shift_id TEXT, actor TEXT NOT NULL, recipient TEXT, document TEXT NOT NULL,
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_purchases(
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES stock_items(id), quantity INTEGER NOT NULL CHECK(quantity>0),
 status TEXT NOT NULL DEFAULT 'draft', author TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS stock_pending_purchase ON stock_purchases(item_id) WHERE status IN ('draft','ordered');
"""

CATALOG = [
 ('Болт М8','шт','free',50),('Гайка М8','шт','free',100),('Шайба М8','шт','free',100),
 ('Винт М6','шт','free',50),('Саморез 4,2×16','шт','free',100),('Стяжка кабельная','шт','free',100),
 ('Предохранитель 10 А','шт','free',20),('Предохранитель 20 А','шт','free',20),
 ('Предохранитель силовой','шт','repair',5),('Вставка графитовая','шт','free',20),
 ('Верёвка штангоуловителя','м','repair',50),('Кабель силовой','м','repair',20),
 ('Провод монтажный','м','free',100),('Лента изоляционная','шт','free',20),
 ('Наконечник кабельный','шт','free',30),('Реле 24 В','шт','repair',5),
 ('Контактор','шт','serial',2),('Преобразователь напряжения','шт','serial',1),
 ('Компрессор','шт','serial',1),('Баллон пневмосистемы','шт','serial',2),
 ('Клапан пневматический','шт','repair',3),('Тормозная накладка','шт','repair',8),
 ('Рукав пневматический','м','repair',20),('Подшипник ступицы','шт','repair',4),
 ('Лампа 24 В','шт','free',20),('Кнопка дверная','шт','repair',10),
 ('Щётка стеклоочистителя','шт','repair',6),('Зеркало наружное','шт','repair',2),
 ('Масло компрессорное','л','repair',20),('Смазка','кг','free',5)
]


def initialize_stock():
    with closing(connect()) as c:
        exists = c.execute("SELECT 1 FROM sqlite_master WHERE name='stock_items'").fetchone()
        if not exists:
            from portable_core import DATA_DIR
            import sqlite3
            dest = DATA_DIR / "migration-backups"
            dest.mkdir(parents=True, exist_ok=True)
            target = sqlite3.connect(dest / ("before-stock-" + new_id() + ".sqlite"))
            try:
                c.backup(target)
            finally:
                target.close()
        c.executescript(SCHEMA)


def scope(user):
    return user.get("access_scope") or "rel"


def stockkeeper(user):
    return user["role"] == "admin" or scope(user) == "warehouse"


def manager(user):
    return user["role"] == "admin" or scope(user) == "management"


def require_keeper(user):
    if not stockkeeper(user):
        raise ApiError(403, "Изменять складской учёт может только склад или администратор.")


def amount(value, unit, zero=False):
    try:
        n = Decimal(str(value).replace(",", "."))
        if not n.is_finite() or n < 0 or (not zero and n == 0) or n > 100000000:
            raise ValueError()
        if n != n.quantize(Decimal(".001")) or (unit == "шт" and n != n.to_integral_value()):
            raise ValueError()
        return int(n * 1000)
    except (InvalidOperation, ValueError, TypeError):
        raise ApiError(400, "Количество должно быть положительным: штуки — целые, метраж, литры и масса — до 3 знаков.")


def visible(order, user):
    if stockkeeper(user) or manager(user):
        return
    assert_department(user, order["department"])


def serials(value):
    if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ApiError(400, "Укажите список заводских номеров.")
    result = [x.strip() for x in value]
    if len(set(result)) != len(result):
        raise ApiError(400, "Заводские номера не должны повторяться.")
    return result


def reserved(c, item_id, except_order=""):
    total = 0
    used = set()
    for row in c.execute("SELECT lines FROM stock_orders WHERE status='collected' AND id<>?", (except_order,)):
        for line in json.loads(row["lines"]):
            if line["item_id"] == item_id:
                total += line["quantity"]
                used.update(line["serials"])
    return total, used


def data(user):
    with closing(connect()) as c:
        items = []
        for row in c.execute("SELECT * FROM stock_items ORDER BY name"):
            item = dict(row)
            held, numbers = reserved(c, item["id"])
            item["reserved"] = held
            item["available"] = item["balance"] - held
            item["serials"] = [dict(x) for x in c.execute("SELECT number,state FROM stock_serials WHERE item_id=? ORDER BY number", (item["id"],))]
            item["reserved_serials"] = sorted(numbers)
            items.append(item)
        orders = []
        for row in c.execute("SELECT * FROM stock_orders ORDER BY created_at DESC,id"):
            order = dict(row)
            try:
                visible(order, user)
            except ApiError:
                continue
            order["lines"] = json.loads(order["lines"])
            orders.append(order)
        movements = [dict(r) for r in c.execute("SELECT * FROM stock_movements ORDER BY created_at DESC,id")]
        if not (stockkeeper(user) or manager(user)):
            movements = [r for r in movements if r["department"] == user.get("department")]
        repairs = [dict(r) for r in c.execute("SELECT id,board,department,description,assigned_user_id FROM requests")
                   if stockkeeper(user) or manager(user) or workflow.can_read(c,r,user)]
        if not (stockkeeper(user) or manager(user)):
            repairs = [r for r in repairs if r["department"] == user.get("department")]
        return {"items": items, "orders": orders, "movements": movements, "repairs": repairs,
                "departments": [r[0] for r in c.execute("SELECT name FROM departments ORDER BY sort_order,name")],
                "fleet": [dict(r) for r in c.execute("SELECT board,model FROM fleet WHERE is_active=1")],
                "shifts": [dict(r) for r in c.execute("SELECT id,name FROM work_shifts")],
                "purchases": [dict(r) for r in c.execute("SELECT * FROM stock_purchases ORDER BY created_at DESC")],
                "alerts": [i for i in items if i["balance"] < i["minimum"]] if stockkeeper(user) or manager(user) else [],
                "canManage": stockkeeper(user), "canPurchase": manager(user)}


def save_item(body, user):
    require_keeper(user)
    name = required(body.get("name"), "Наименование")
    unit, policy = text(body.get("unit")), text(body.get("policy"))
    if unit not in ("шт", "м", "л", "кг") or policy not in ("free", "repair", "serial") or (policy == "serial" and unit != "шт"):
        raise ApiError(400, "Проверьте единицу измерения и режим выдачи.")
    minimum = amount(body.get("minimum", 0), unit, True)
    with transaction() as c:
        ident = text(body.get("id")) or new_id()
        old = c.execute("SELECT * FROM stock_items WHERE id=?", (ident,)).fetchone()
        if old and (old["unit"] != unit or old["policy"] != policy):
            raise ApiError(409, "Единица и режим существующей позиции неизменны: создайте отдельную номенклатуру.")
        c.execute("INSERT INTO stock_items(id,name,unit,policy,minimum) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,minimum=excluded.minimum", (ident,name,unit,policy,minimum))
        write_audit(c,user,"stock_item","stock_item",ident,body)
    return {"id": ident}


def seed_catalog(user):
    require_keeper(user)
    with transaction() as c:
        for name, unit, policy, minimum in CATALOG:
            c.execute("INSERT OR IGNORE INTO stock_items(id,name,unit,policy,minimum) VALUES(?,?,?,?,?)", (new_id(),name,unit,policy,minimum*1000))
        write_audit(c,user,"stock_catalog","stock_item",None,{"positions":30,"balances":0})
    return {"count":30}


def receipt(body, user):
    require_keeper(user)
    with transaction() as c:
        item = c.execute("SELECT * FROM stock_items WHERE id=?", (text(body.get("item_id")),)).fetchone()
        if not item:
            raise ApiError(404, "Материал не найден.")
        qty = amount(body.get("quantity"), item["unit"])
        numbers = serials(body.get("serials", []))
        if item["policy"] == "serial":
            if len(numbers)*1000 != qty:
                raise ApiError(400, "Количество должно совпадать с числом заводских номеров.")
            for number in numbers:
                c.execute("INSERT INTO stock_serials(item_id,number) VALUES(?,?)", (item["id"],number))
        elif numbers:
            raise ApiError(400, "У этой позиции нет серийного учёта.")
        document = required(body.get("document"), "Документ / основание поступления")
        c.execute("UPDATE stock_items SET balance=balance+? WHERE id=?", (qty,item["id"]))
        c.execute("INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (new_id(),item["id"],qty,"receipt",json.dumps(numbers),None,None,None,None,user["display_name"],None,document,now_iso()))
        write_audit(c,user,"stock_receipt","stock_item",item["id"],body)
    return {"ok":True}


def create_order(body, user):
    if scope(user) == "management" and user["role"] != "admin":
        raise ApiError(403, "Руководство рассматривает закупки; потребности оформляет участок или склад.")
    with transaction() as c:
        repair_id = text(body.get("repair_id")) or None
        repair = c.execute("SELECT * FROM requests WHERE id=?", (repair_id,)).fetchone() if repair_id else None
        if repair_id and not repair:
            raise ApiError(409, "Ремонтная заявка уже закрыта или не найдена.")
        if repair:
            board, department, description = repair["board"], repair["department"], repair["description"]
            if not stockkeeper(user):
                workflow.assert_owner(c,repair,user)
        else:
            board, department, description = required(body.get("board"),"Борт"), required(body.get("department"),"Участок"), ""
        if not stockkeeper(user):
            assert_department(user,department)
        if not c.execute("SELECT 1 FROM fleet WHERE board=? AND is_active=1",(board,)).fetchone() or not c.execute("SELECT 1 FROM departments WHERE name=?",(department,)).fetchone():
            raise ApiError(400,"Борт или участок не найден.")
        shift_id = text(body.get("shift_id")) or user.get("shift_id") or None
        if shift_id and not c.execute("SELECT 1 FROM work_shifts WHERE id=?",(shift_id,)).fetchone():
            raise ApiError(400,"Неизвестная смена.")
        if not stockkeeper(user) and user.get("shift_id") and shift_id != user["shift_id"]:
            raise ApiError(403,"Нельзя оформлять потребность от другой смены.")
        if department != TO_DEPARTMENT:
            shift_id = None
        lines = body.get("lines")
        if not isinstance(lines,list) or not 1 <= len(lines) <= 100:
            raise ApiError(400,"Добавьте от 1 до 100 материалов.")
        result, seen = [], set()
        for line in lines:
            if not isinstance(line, dict):
                raise ApiError(400,"Некорректная строка материалов.")
            item = c.execute("SELECT * FROM stock_items WHERE id=?",(text(line.get("item_id")),)).fetchone()
            if not item or item["id"] in seen:
                raise ApiError(400,"Материал не найден или повторяется.")
            seen.add(item["id"])
            if not repair and item["policy"] != "free":
                raise ApiError(400,"Этот материал выдаётся только по ремонтной заявке.")
            qty = amount(line.get("quantity"),item["unit"])
            numbers = serials(line.get("serials",[]))
            if numbers and item["policy"] != "serial":
                raise ApiError(400,"Номера допустимы только для номерных узлов.")
            result.append({"item_id":item["id"],"name":item["name"],"unit":item["unit"],"quantity":qty,"serials":numbers})
        ident, now = new_id(), now_iso()
        c.execute("INSERT INTO stock_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (ident,repair_id,board,department,shift_id,description,"requested",json.dumps(result,ensure_ascii=False),
                   text(body.get("note")),user["display_name"],now,now,None,None))
        write_audit(c,user,"stock_request","stock_order",ident,body)
    return {"id":ident}


def order_action(ident, body, user):
    require_keeper(user)
    action = text(body.get("action"))
    with transaction() as c:
        row = c.execute("SELECT * FROM stock_orders WHERE id=?",(ident,)).fetchone()
        if not row:
            raise ApiError(404,"Заказ не найден.")
        if row["status"] in ("issued","cancelled"):
            raise ApiError(409,"Заказ уже завершён. Повторная выдача запрещена.")
        lines = json.loads(row["lines"])
        if action == "cancel":
            note = required(body.get("note"),"Причина отмены")
            c.execute("UPDATE stock_orders SET status='cancelled',note=note||?,updated_at=? WHERE id=?",("\nОтмена: "+note,now_iso(),ident))
        elif action in ("collect","issue"):
            supplied = body.get("serials", {})
            if not isinstance(supplied,dict):
                raise ApiError(400,"Неверные заводские номера.")
            for line in lines:
                item = c.execute("SELECT * FROM stock_items WHERE id=?",(line["item_id"],)).fetchone()
                held, reserved_numbers = reserved(c,item["id"],ident)
                if item["balance"] - held < line["quantity"]:
                    raise ApiError(409,"Недостаточно доступного остатка: "+item["name"])
                numbers = serials(supplied.get(item["id"],line["serials"]))
                if item["policy"] == "serial":
                    if len(numbers)*1000 != line["quantity"]:
                        raise ApiError(400,"Выберите все заводские номера: "+item["name"])
                    for number in numbers:
                        found = c.execute("SELECT 1 FROM stock_serials WHERE item_id=? AND number=? AND state='stock'",(item["id"],number)).fetchone()
                        if not found or number in reserved_numbers:
                            raise ApiError(409,"Заводской номер недоступен: "+number)
                elif numbers:
                    raise ApiError(400,"Этот материал не является номерным.")
                line["serials"] = numbers
            now = now_iso()
            recipient = required(body.get("recipient"),"Получатель") if action == "issue" else None
            if action == "issue":
                for line in lines:
                    c.execute("UPDATE stock_items SET balance=balance-? WHERE id=?",(line["quantity"],line["item_id"]))
                    for number in line["serials"]:
                        c.execute("UPDATE stock_serials SET state='issued' WHERE item_id=? AND number=?",(line["item_id"],number))
                    c.execute("INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                              (new_id(),line["item_id"],line["quantity"],"issue",json.dumps(line["serials"]),ident,row["board"],row["department"],row["shift_id"],user["display_name"],recipient,text(body.get("note")),now))
            c.execute("UPDATE stock_orders SET status=?,lines=?,updated_at=?,recipient=?,issued_at=? WHERE id=?",
                      ("issued" if action=="issue" else "collected",json.dumps(lines,ensure_ascii=False),now,recipient,now if action=="issue" else None,ident))
        else:
            raise ApiError(400,"Неизвестное действие.")
        write_audit(c,user,"stock_"+action,"stock_order",ident,body)
    return {"ok":True}


def purchase(body,user):
    if not manager(user):
        raise ApiError(403,"Заявки на закупку создаёт руководство.")
    with transaction() as c:
        item = c.execute("SELECT * FROM stock_items WHERE id=?",(text(body.get("item_id")),)).fetchone()
        if not item:
            raise ApiError(404,"Материал не найден.")
        ident = new_id()
        qty = amount(body.get("quantity"),item["unit"])
        c.execute("INSERT INTO stock_purchases(id,item_id,quantity,author,created_at) VALUES(?,?,?,?,?)",(ident,item["id"],qty,user["display_name"],now_iso()))
        write_audit(c,user,"stock_purchase","stock_purchase",ident,body)
    return {"id":ident}


def purchase_action(ident, body, user):
    if not manager(user):
        raise ApiError(403,"Закупки изменяет руководство.")
    status = text(body.get("status"))
    if status not in ("ordered","received","cancelled"):
        raise ApiError(400,"Некорректный статус закупки.")
    with transaction() as c:
        row = c.execute("SELECT * FROM stock_purchases WHERE id=?",(ident,)).fetchone()
        if not row:
            raise ApiError(404,"Заявка не найдена.")
        if row["status"] in ("received","cancelled"):
            raise ApiError(409,"Заявка уже завершена.")
        c.execute("UPDATE stock_purchases SET status=? WHERE id=?",(status,ident))
        write_audit(c,user,"stock_purchase_status","stock_purchase",ident,body)
    return {"ok":True}

