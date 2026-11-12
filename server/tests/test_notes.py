import unittest,json
import test_shifts_roles as base
import portable_core as core
import portable_workflow as workflow
from portable_modules import add_request,get_state,complete_request
from portable_users import create_user

class NoteTests(unittest.TestCase):
    setUp=base.ShiftRoleTests.setUp
    tearDown=base.ShiftRoleTests.tearDown
    raw=base.ShiftRoleTests.raw
    profile=base.ShiftRoleTests.profile

    def general(self):
        p=self.profile("master","day_2")
        with core.transaction() as c:c.execute("UPDATE users SET shift_id=NULL WHERE id=?",(p["id"],))
        return self.raw(p)

    def public(self,r):
        with core.connect() as c:return workflow.public_flow(c,r["id"])

    def decide(self,r,action,user,note=""):
        return workflow.decide(r["id"],{"action":action,"note":note,"version":self.public(r)["version"]},user)

    def delete(self,r,note,user):
        return workflow.delete_note(r["id"],note["id"],{"version":self.public(r)["version"]},user)

    def test_keep_live_notes_in_repair_and_board_history(self):
        g=self.general()
        r=add_request({"board":"TEST-1","description":"Ремонт №1","intake":"general"},g)
        self.decide(r,"note",g,"Оставить в технической истории")
        self.decide(r,"note",g,"Временная заметка для удаления")
        notes=self.public(r)["notes"]
        self.assertEqual(notes[0]["authorId"],g["id"])
        self.delete(r,notes[1],g)
        self.assertEqual(len(self.public(r)["notes"]),1)
        self.assertNotIn("Временная заметка",json.dumps(self.public(r),ensure_ascii=False))
        self.decide(r,"accept",g)
        closed=complete_request(r["id"],{"workDone":"Выполнен ремонт","flowVersion":self.public(r)["version"]},g)
        h=next(x for x in get_state(g,True,False)["history"] if x["id"]==closed["id"])
        self.assertEqual(h["board"],"TEST-1")
        self.assertEqual([n["text"] for n in h["flow"]["notes"]],["Оставить в технической истории"])
        with self.assertRaises(core.ApiError):self.delete(r,notes[0],self.admin)
        self.assertTrue(any(e["action"]=="note_deleted" for e in h["flow"]["events"]))

    def test_owner_admin_foreign_note_and_stale_version(self):
        one,two=self.general(),self.general()
        r=add_request({"board":"TEST-1","description":"Ремонт","intake":"general"},one)
        self.decide(r,"note",one,"Авторская заметка")
        n=self.public(r)["notes"][0]
        with self.assertRaises(core.ApiError):self.delete(r,n,two)
        old=self.public(r)["version"]
        self.decide(r,"note",one,"Новая заметка")
        with self.assertRaises(core.ApiError):
            workflow.delete_note(r["id"],n["id"],{"version":old},one)
        other=add_request({"board":"TEST-1","description":"Другой ремонт","intake":"general"},one)
        with self.assertRaises(core.ApiError):self.delete(other,n,self.admin)
        self.delete(r,n,self.admin)
        self.assertEqual(len(self.public(r)["notes"]),1)
        with self.assertRaises(core.ApiError):self.delete(r,n,self.admin)
        event=self.public(r)["events"][0]
        with self.assertRaises(core.ApiError):self.delete(r,event,self.admin)

    def test_legacy_notes_preserved_and_admin_can_delete(self):
        g=self.general()
        r=add_request({"board":"TEST-1","description":"Ремонт","intake":"general"},g)
        self.decide(r,"note",g,"Заметка до обновления")
        note=self.public(r)["notes"][0]
        with core.transaction() as c:c.execute("DELETE FROM request_note_meta WHERE event_id=?",(note["id"],))
        self.assertEqual(self.public(r)["notes"][0]["text"],"Заметка до обновления")
        with self.assertRaises(core.ApiError):self.delete(r,note,g)
        self.delete(r,note,self.admin)
        self.assertEqual(self.public(r)["notes"],[])

    def test_backup_restore_preserves_note_deletions(self):
        import portable_export
        import portable_stock
        portable_stock.initialize_stock()
        g=self.general()
        r=add_request({"board":"TEST-1","description":"Экспорт","intake":"general"},g)
        self.decide(r,"note",g,"Сохранить")
        self.decide(r,"note",g,"Удалить")
        self.delete(r,self.public(r)["notes"][1],g)
        export=portable_export._logical_export()
        original=(core.DATA_DIR,core.DB_PATH,core.SEED_PATH)
        folder=core.DATA_DIR/"notes-restore";folder.mkdir()
        core.DATA_DIR=folder;core.DB_PATH=folder/"restore.sqlite";core.SEED_PATH=folder/"seed.json"
        core.SEED_PATH.write_text(json.dumps(export),encoding="utf-8")
        try:
            core.initialize_database()
            self.assertEqual([n["text"] for n in self.public(r)["notes"]],["Сохранить"])
        finally:core.DATA_DIR,core.DB_PATH,core.SEED_PATH=original

if __name__=="__main__":unittest.main()

