import unittest
from unittest.mock import patch
import test_shifts_roles as base
import portable_core as core
import portable_workflow as flow
from portable_modules import add_request,get_state,complete_request,update_request
from datetime import datetime
from portable_shifts import shift_for_instant,DEFAULT_SETTINGS

class WorkflowTests(unittest.TestCase):
    setUp=base.ShiftRoleTests.setUp
    tearDown=base.ShiftRoleTests.tearDown
    raw=base.ShiftRoleTests.raw
    profile=base.ShiftRoleTests.profile

    def create(self,creator=None,**extra):
        return add_request({"board":"TEST-1","description":"Дефект",**extra},creator or self.admin)

    def decide(self,r,action,actor=None,**extra):
        with core.connect() as c:
            version=flow.flow(c,r["id"])["version"]
        return flow.decide(r["id"],{"action":action,"version":version,**extra},actor or self.admin)

    def general(self):
        p=self.profile("master","day_2")
        with core.transaction() as c:c.execute("UPDATE users SET shift_id=NULL WHERE id=?",(p["id"],))
        return self.raw(p)

    def test_intake_calendar_visibility_and_general(self):
        teams={s:self.profile("master",s) for s in ("day_1","day_2","night_1","night_2")}
        rel=self.profile("rel")
        for moment,expected in [("2026-10-01T08:00","day_1"),("2026-10-02T20:00","night_1"),("2026-10-03T07:59","night_1"),("2026-10-03T08:00","day_2"),("2026-10-04T20:00","night_2")]:
            current=shift_for_instant(DEFAULT_SETTINGS,datetime.fromisoformat(moment))
            with patch("portable_workflow.shift_for_instant",return_value=current):
                r=self.create(rel)
            self.assertEqual(r["department"],core.TO_DEPARTMENT)
            self.assertEqual(r["flow"]["shiftId"],expected)
            self.assertFalse(get_state(rel,False,False)["requests"])
            for shift,person in teams.items():
                self.assertEqual(any(x["id"]==r["id"] for x in get_state(person,False,False)["requests"]),shift==expected)
        g=self.general()
        r=self.create(rel,intake="general")
        self.assertIsNone(r["flow"]["shiftId"])
        self.assertTrue(any(x["id"]==r["id"] for x in get_state(g,False,False)["requests"]))

    def test_fallback_without_configured_shift(self):
        r=self.create()
        self.assertIsNone(r["flow"]["shiftId"])
        self.assertEqual(r["flow"]["stage"],"incoming")

    def test_yandex_requests_use_same_intake(self):
        import portable_yandex
        form={"type":"request","department":"РЭЛ","sourceKey":"qa-form","source":"Форма","createdBy":"Водитель",
              "boardFields":["board"],"descriptionFields":["description"],"workDoneFields":["work"]}
        with patch("portable_yandex._field",side_effect=lambda answer,cols,fields:{"board":"TEST-1","description":"От водителя","work":""}[fields[0]]):
            self.assertEqual(portable_yandex._import_answer({"id":"QA-123"},[],form),"imported")
            self.assertEqual(portable_yandex._import_answer({"id":"QA-123"},[],form),"duplicate")
        requests=get_state(self.admin,False,False)["requests"]
        r=next(r for r in requests if r["externalId"]=="QA-123")
        self.assertEqual(r["department"],core.TO_DEPARTMENT)
        self.assertEqual(r["flow"]["stage"],"incoming")

    def test_handoff_same_department_and_other_department(self):
        one=self.profile("master","day_1")
        two=self.profile("master","night_2")
        r=self.create(intake="general")
        self.decide(r,"transfer_shift",shiftId="day_1",note="Передано из общего профиля")
        self.decide(r,"accept",one)
        self.decide(r,"transfer_shift",one,shiftId="night_2",note="Выполнено: диагностика. Осталось: замена.")
        with self.assertRaises(core.ApiError):self.decide(r,"accept",one)
        self.decide(r,"accept",two)
        self.decide(r,"transfer_department",two,department="РЭЛ",note="Выполнено: диагностика. Осталось: ремонт платы.")
        rel=self.profile("rel")
        self.assertTrue(any(x["id"]==r["id"] for x in get_state(rel,False,False)["requests"]))
        with self.assertRaises(core.ApiError):self.decide(r,"accept",two)
        self.decide(r,"accept",rel)
        with self.assertRaises(core.ApiError):self.decide(r,"transfer_shift",rel,shiftId="day_1",note="Не должно пройти")

    def test_review_plan_reject_and_archive(self):
        g=self.general()
        manager=self.profile("management")
        r=self.create(intake="general")
        self.decide(r,"review",g,note="Необходима закупка узла")
        self.assertFalse(any(x["id"]==r["id"] for x in get_state(g,False,False)["requests"]))
        with self.assertRaises(core.ApiError):self.decide(r,"accept",g)
        self.decide(r,"plan",manager,department=core.TO_DEPARTMENT,shiftId="",plannedDate=datetime.now(flow.MOSCOW).date().isoformat(),note="Ремонт в плановом порядке")
        self.decide(r,"accept",g)
        self.decide(r,"reject",g,note="Замечание не подтвердилось. При повторении — диагностика.")
        history=get_state(self.admin,True,False)["history"]
        h=next(x for x in history if x["status"]=="rejected")
        self.assertIn("не подтвердилось",h["note"])
        self.assertEqual(h["flow"]["outcome"],"rejected")
        self.assertGreaterEqual(len(h["flow"]["events"]),5)

    def test_optimistic_version_and_completion_guards(self):
        g=self.general()
        r=self.create(intake="general")
        with self.assertRaises(core.ApiError):complete_request(r["id"],{"workDone":"Готово","flowVersion":1},g)
        self.decide(r,"accept",g)
        with self.assertRaises(core.ApiError):flow.decide(r["id"],{"action":"wait","version":1,"note":"Опоздавшее изменение"},g)
        with self.assertRaises(core.ApiError):update_request(r["id"],{"status":"waiting","flowVersion":2},g)
        self.decide(r,"note",g,note="Заменён предохранитель")
        result=complete_request(r["id"],{"workDone":"Проверено, ремонт завершён","flowVersion":3},g)
        h=next(x for x in get_state(self.admin,True,False)["history"] if x["id"]==result["id"])
        self.assertEqual(h["flow"]["outcome"],"completed")
        self.assertTrue(any(n["text"]=="Заменён предохранитель" for n in h["flow"]["notes"]))

if __name__=="__main__":unittest.main()

