import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_shifts_roles as shifts_tests
import portable_core as core
import portable_stock as stock
import portable_workflow as workflow
from portable_modules import add_request, complete_request
from portable_users import create_user
import unittest
import json

class StockTests(unittest.TestCase):
    raw = shifts_tests.ShiftRoleTests.raw
    profile = shifts_tests.ShiftRoleTests.profile
    tearDown = shifts_tests.ShiftRoleTests.tearDown
    def setUp(self):
        shifts_tests.ShiftRoleTests.setUp(self)
        stock.initialize_stock()
        self.keeper=self.profile("warehouse")
        self.rel=self.profile("rel")
        self.master=self.profile("master","day_1")
        stock.seed_catalog(self.keeper)
        self.items={x["name"]:x for x in stock.data(self.admin)["items"]}

    def new_repair(self):
        ident=add_request({"board":"TEST-1","department":"РЭЛ","description":"Проверка склада"},self.rel)["id"]
        self.decide(ident,"transfer_department",department="РЭЛ",note="Выполнено: приём. Осталось: ремонт РЭЛ.")
        return ident

    def decide(self,ident,action,**extra):
        with core.connect() as c:
            version=workflow.flow(c,ident)["version"]
        return workflow.decide(ident,{"action":action,"version":version,**extra},self.admin)

    def to_master(self,ident):
        self.decide(ident,"plan",plannedDate=__import__('datetime').date.today().isoformat(),shiftId="day_1",note="Назначение на смену для проверки")
        self.decide(ident,"accept")

    def finish(self,ident,actor):
        self.decide(ident,"accept")
        with core.connect() as c:
            version=workflow.flow(c,ident)["version"]
        return complete_request(ident,{"workDone":"Готово","flowVersion":version},actor)

    def order(self,name,quantity=1,repair=True,user=None,**extra):
        user=user or self.rel
        return stock.create_order({"board":"TEST-1","department":"РЭЛ",
            "repair_id":self.new_repair() if repair else None,
            "lines":[{"item_id":self.items[name]["id"],"quantity":quantity}],**extra},user)["id"]

    def receive(self,name,qty=10,numbers=None):
        stock.receipt({"item_id":self.items[name]["id"],"quantity":qty,"serials":numbers or [],"document":"Тестовая накладная"},self.keeper)

    def test_catalog_empty_balances(self):
        self.assertEqual(len(self.items),30)
        self.assertTrue(all(x["balance"]==0 for x in self.items.values()))
        stock.seed_catalog(self.keeper)
        self.assertEqual(len(stock.data(self.admin)["items"]),30)

    def test_receipt_issue_replay_and_snapshot(self):
        self.receive("Болт М8",10)
        ident=self.order("Болт М8",4,False)
        stock.order_action(ident,{"action":"collect"},self.keeper)
        item=next(x for x in stock.data(self.keeper)["items"] if x["name"]=="Болт М8")
        self.assertEqual((item["balance"],item["reserved"],item["available"]),(10000,4000,6000))
        stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        with self.assertRaises(core.ApiError):
            stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        self.assertEqual(len([m for m in stock.data(self.admin)["movements"] if m["kind"]=="issue"]),1)

    def test_serials_required_and_unique(self):
        self.receive("Баллон пневмосистемы",2,["TEST-A","TEST-B"])
        with self.assertRaises(core.ApiError):self.order("Баллон пневмосистемы",1,False)
        ident=self.order("Баллон пневмосистемы")
        with self.assertRaises(core.ApiError):stock.order_action(ident,{"action":"collect"},self.keeper)
        stock.order_action(ident,{"action":"collect","serials":{self.items["Баллон пневмосистемы"]["id"]:["TEST-A"]}},self.keeper)
        second=self.order("Баллон пневмосистемы")
        with self.assertRaises(core.ApiError):
            stock.order_action(second,{"action":"collect","serials":{self.items["Баллон пневмосистемы"]["id"]:["TEST-A"]}},self.keeper)
        stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        self.assertEqual(stock.data(self.admin)["orders"][0]["department"],"РЭЛ")

    def test_metres_and_atomic_insufficient(self):
        self.receive("Верёвка штангоуловителя","10.5")
        with self.assertRaises(core.ApiError):self.order("Верёвка штангоуловителя",1,False)
        ident=self.order("Верёвка штангоуловителя","2.75")
        stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        i=next(x for x in stock.data(self.admin)["items"] if x["name"]=="Верёвка штангоуловителя")
        self.assertEqual(i["balance"],7750)
        fail=self.order("Верёвка штангоуловителя",8)
        with self.assertRaises(core.ApiError):stock.order_action(fail,{"action":"issue","recipient":"Мастер"},self.keeper)
        with self.assertRaises(core.ApiError):self.order("Болт М8","1.1",False)

    def test_isolation_and_purchase(self):
        with self.assertRaises(core.ApiError):self.receive_as_rel()
        with self.assertRaises(core.ApiError):stock.purchase({"item_id":self.items["Болт М8"]["id"],"quantity":5},self.rel)
        stock.purchase({"item_id":self.items["Болт М8"]["id"],"quantity":50},self.admin)
        with self.assertRaises(Exception):stock.purchase({"item_id":self.items["Болт М8"]["id"],"quantity":50},self.admin)
        self.assertTrue(stock.data(self.admin)["alerts"])
        self.assertFalse(stock.data(self.rel)["alerts"])
        with self.assertRaises(core.ApiError):self.order("Болт М8",1,False,department="Другой участок")

    def receive_as_rel(self):
        stock.receipt({"item_id":self.items["Болт М8"]["id"],"quantity":5,"document":"x"},self.rel)

    def test_concurrent_handover_and_cancel_reserve(self):
        from concurrent.futures import ThreadPoolExecutor
        self.receive("Болт М8",10)
        ident=self.order("Болт М8",6,False)
        stock.order_action(ident,{"action":"collect"},self.keeper)
        second=self.order("Болт М8",5,False)
        with self.assertRaises(core.ApiError):
            stock.order_action(second,{"action":"collect"},self.keeper)
        stock.order_action(ident,{"action":"cancel","note":"Отмена потребности"},self.keeper)
        stock.order_action(second,{"action":"collect"},self.keeper)
        def issue():
            try:
                stock.order_action(second,{"action":"issue","recipient":"Мастер"},self.keeper)
                return True
            except core.ApiError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(lambda _:issue(),range(2))),1)
        self.assertEqual(next(i for i in stock.data(self.admin)["items"] if i["name"]=="Болт М8")["balance"],5000)

    def test_multiline_failure_rolls_back_and_purchase_reopen(self):
        self.receive("Болт М8",10)
        ident=stock.create_order({"repair_id":self.new_repair(),"lines":[
            {"item_id":self.items["Болт М8"]["id"],"quantity":5},
            {"item_id":self.items["Гайка М8"]["id"],"quantity":5}]},self.rel)["id"]
        with self.assertRaises(core.ApiError):
            stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        self.assertEqual(next(i for i in stock.data(self.admin)["items"] if i["name"]=="Болт М8")["balance"],10000)
        body={"item_id":self.items["Болт М8"]["id"],"quantity":20}
        p=stock.purchase(body,self.admin)["id"]
        stock.purchase_action(p,{"status":"ordered"},self.admin)
        stock.purchase_action(p,{"status":"received"},self.admin)
        stock.purchase(body,self.admin)

    def test_shift_snapshot_and_logical_restore(self):
        import portable_export
        self.receive("Болт М8",10)
        repair=add_request({"board":"TEST-1","department":core.TO_DEPARTMENT,"description":"Смена ТО"},self.master)["id"]
        self.to_master(repair)
        ident=stock.create_order({"repair_id":repair,"lines":[{"item_id":self.items["Болт М8"]["id"],"quantity":3}]},self.master)["id"]
        stock.order_action(ident,{"action":"issue","recipient":"Дневной мастер"},self.keeper)
        order=next(o for o in stock.data(self.admin)["orders"] if o["id"]==ident)
        self.assertEqual(order["shift_id"],"day_1")
        export=portable_export._logical_export()
        original=(core.DATA_DIR,core.DB_PATH,core.SEED_PATH)
        folder=core.DATA_DIR/"restored"
        folder.mkdir()
        core.DATA_DIR=folder
        core.DB_PATH=folder/"restored.sqlite"
        core.SEED_PATH=folder/"seed.json"
        core.SEED_PATH.write_text(json.dumps(export),encoding="utf-8")
        try:
            core.initialize_database()
            self.assertEqual(len(stock.data(self.admin)["items"]),30)
            self.assertEqual(next(o for o in stock.data(self.admin)["orders"] if o["id"]==ident)["shift_id"],"day_1")
        finally:
            core.DATA_DIR,core.DB_PATH,core.SEED_PATH=original

    def test_department_rename_preserves_repair_stock_and_credentials(self):
        self.receive("Болт М8",10)
        repair=add_request({"board":"TEST-1","department":core.TO_DEPARTMENT,"description":"Сохранить ремонт"},self.master)["id"]
        self.to_master(repair)
        ident=stock.create_order({"repair_id":repair,"lines":[{"item_id":self.items["Болт М8"]["id"],"quantity":2}]},self.master)["id"]
        stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        self.finish(repair,self.master)
        with core.transaction() as c:
            c.execute("UPDATE departments SET name=? WHERE name=?",(core.LEGACY_TO_DEPARTMENT,core.TO_DEPARTMENT))
            c.execute("UPDATE stock_orders SET department=? WHERE id=?",(core.LEGACY_TO_DEPARTMENT,ident))
            c.execute("UPDATE stock_movements SET department=? WHERE order_id=?",(core.LEGACY_TO_DEPARTMENT,ident))
            c.execute("UPDATE users SET display_name=? WHERE id=?",(core.LEGACY_TO_DEPARTMENT+" · Дневная смена №1",self.master["id"]))
            c.execute("DELETE FROM app_meta WHERE key='repair_department_name_v1'")
        before=self.raw({"id":self.master["id"]})
        core.initialize_database()
        after=self.raw({"id":self.master["id"]})
        for key in ("id","password_hash","password_salt","password_iterations","shift_id","access_scope"):
            self.assertEqual(before[key],after[key])
        self.assertEqual(after["department"],core.TO_DEPARTMENT)
        self.assertTrue(after["display_name"].startswith(core.TO_DEPARTMENT))
        self.assertEqual(next(o for o in stock.data(self.admin)["orders"] if o["id"]==ident)["department"],core.TO_DEPARTMENT)
        with core.connect() as c:
            self.assertEqual(c.execute("SELECT department FROM repair_history WHERE description='Сохранить ремонт'").fetchone()[0],core.TO_DEPARTMENT)
            self.assertEqual(c.execute("SELECT department FROM stock_movements WHERE order_id=?",(ident,)).fetchone()[0],core.TO_DEPARTMENT)
            self.assertFalse(c.execute("PRAGMA foreign_key_check").fetchall())
        core.initialize_database()
        self.assertEqual(self.raw({"id":self.master["id"]})["shift_id"],"day_1")

    def test_closed_repair_keeps_issue_history(self):
        self.receive("Болт М8",5)
        repair=self.new_repair()
        ident=self.order("Болт М8",2,repair_id=repair)
        stock.order_action(ident,{"action":"issue","recipient":"Мастер"},self.keeper)
        self.finish(repair,self.rel)
        order=next(x for x in stock.data(self.admin)["orders"] if x["id"]==ident)
        self.assertEqual(order["repair_id"],repair)
        self.assertEqual(order["repair_description"],"Проверка склада")

if __name__=="__main__":unittest.main()

