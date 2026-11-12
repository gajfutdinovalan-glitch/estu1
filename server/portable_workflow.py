from __future__ import annotations
import json
from datetime import date
from portable_core import (ApiError, TO_DEPARTMENT, connect, transaction, new_id, now_iso,
                           required, text, write_audit, assert_permission)
from portable_shifts import schedule_settings, shift_for_instant, SHIFT_IDS, MOSCOW
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS request_flow(
 request_id TEXT PRIMARY KEY, shift_id TEXT REFERENCES work_shifts(id),
 stage TEXT NOT NULL CHECK(stage IN ('incoming','work','wait','review','planned','closed')),
 planned_date TEXT, version INTEGER NOT NULL DEFAULT 1, history_id TEXT UNIQUE,
 outcome TEXT, legacy INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS request_events(
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES request_flow(request_id),
 created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL,
 from_department TEXT, to_department TEXT, from_shift TEXT, to_shift TEXT,
 from_stage TEXT, to_stage TEXT, planned_date TEXT);
CREATE INDEX IF NOT EXISTS request_events_order ON request_events(request_id,created_at);
CREATE TABLE IF NOT EXISTS request_note_meta(
 event_id TEXT PRIMARY KEY REFERENCES request_events(id),
 author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 deleted_at TEXT, deleted_by TEXT);
"""

def flow(c, ident):
    row=c.execute("SELECT * FROM request_flow WHERE request_id=?",(ident,)).fetchone()
    return dict(row) if row else None

def event(c,ident,user,action,note,before,after,old_dep,new_dep):
    event_id = new_id()
    c.execute("INSERT INTO request_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (event_id,ident,datetime.now(MOSCOW).isoformat(timespec="seconds"),user["display_name"] if user else "Система",
               action,note,old_dep,new_dep,before.get("shift_id"),after.get("shift_id"),
               before.get("stage"),after.get("stage"),after.get("planned_date")))
    if action == "note":
        c.execute("INSERT INTO request_note_meta(event_id,author_id) VALUES(?,?)",(event_id,user["id"] if user else None))

def intake(c,ident,user=None,general=False):
    row=c.execute("SELECT * FROM requests WHERE id=?",(ident,)).fetchone()
    current=shift_for_instant(schedule_settings(c))
    exists=c.execute("SELECT 1 FROM users WHERE access_scope='master' AND shift_id=? AND is_active=1",(current["id"],)).fetchone()
    shift=None if general or not exists else current["id"]
    c.execute("INSERT INTO request_flow(request_id,shift_id,stage) VALUES(?,?,'incoming')",(ident,shift))
    c.execute("UPDATE requests SET department=?,assigned_user_id=NULL,status='new' WHERE id=?",(TO_DEPARTMENT,ident))
    event(c,ident,user,"intake","Входящая заявка: "+("общий профиль" if shift is None else shift),{},flow(c,ident),row["department"],TO_DEPARTMENT)

def ensure(c,row):
    f=flow(c,row["id"])
    if f is None:
        stage={"new":"incoming","waiting":"wait","in_progress":"work"}[row["status"]]
        c.execute("INSERT INTO request_flow(request_id,stage,legacy) VALUES(?,?,1)",(row["id"],stage))
        f=flow(c,row["id"])
        event(c,row["id"],None,"legacy","Заявка создана до изменения маршрутизации.",{},f,row["department"],row["department"])
    return f

def can_read(c,row,user):
    if user["role"]=="admin" or user.get("access_scope")=="management":
        return True
    if row["department"]!=user.get("department"):
        return False
    f=flow(c,row["id"])
    if f and f["stage"]=="review":
        return False
    if row["department"]==TO_DEPARTMENT and f and not f["legacy"]:
        return user.get("access_scope")=="master" and (not user.get("shift_id") or user.get("shift_id")==f["shift_id"])
    return True

def assert_owner(c,row,user):
    f=flow(c,row["id"])
    if user["role"]=="admin":
        return
    if f and f["stage"]=="review":
        if user.get("access_scope")=="management":
            return
        raise ApiError(403,"Заявка передана на рассмотрение руководству.")
    if user.get("access_scope")=="management" or not can_read(c,row,user):
        raise ApiError(403,"Заявка находится у другого участка или смены.")
    if user.get("access_scope")=="warehouse":
        raise ApiError(403,"Склад не управляет ремонтом.")

def public_flow(c,ident):
    f=flow(c,ident)
    if not f:
        return None
    return {"stage":f["stage"],"shiftId":f["shift_id"],"plannedDate":f["planned_date"],
            "version":f["version"],"outcome":f["outcome"],"legacy":bool(f["legacy"]),
            "notes":[dict(r) for r in c.execute("""
                SELECT e.id,e.note text,e.actor,e.created_at createdAt,m.author_id authorId
                FROM request_events e LEFT JOIN request_note_meta m ON m.event_id=e.id
                WHERE e.request_id=? AND e.action='note' AND m.deleted_at IS NULL
                ORDER BY e.created_at,e.rowid""",(ident,))],
            "events":[dict(r) for r in c.execute("SELECT * FROM request_events WHERE request_id=? AND action<>'note' ORDER BY created_at,rowid",(ident,))]}

def close(c,row,user,outcome,note,history_id):
    before=ensure(c,row)
    after={**before,"stage":"closed","version":before["version"]+1}
    c.execute("UPDATE request_flow SET stage='closed',outcome=?,history_id=?,version=version+1 WHERE request_id=?",
              (outcome,history_id,row["id"]))
    event(c,row["id"],user,outcome,note,before,after,row["department"],row["department"])

def decide(ident,body,user):
    assert_permission(user,"editRequests")
    with transaction() as c:
        row=c.execute("SELECT * FROM requests WHERE id=?",(ident,)).fetchone()
        if row is None:
            raise ApiError(404,"Заявка не найдена или уже закрыта.")
        assert_owner(c,row,user)
        before=ensure(c,row)
        if body.get("version")!=before["version"]:
            raise ApiError(409,"Заявка уже изменена. Обновите список и повторите действие.")
        action=text(body.get("action"))
        note=text(body.get("note"))
        after={**before,"legacy":0}
        department=row["department"]
        if before["legacy"] and department==TO_DEPARTMENT and user.get("shift_id"):
            after["shift_id"]=user["shift_id"]
        if before["stage"]=="review" and user.get("access_scope") not in ("management","admin") and user["role"]!="admin":
            raise ApiError(403,"Решение принимает руководство.")
        if before["stage"]=="review" and action not in ("transfer_department","transfer_shift","plan","reject","note"):
            raise ApiError(400,"Направьте заявку в участок, запланируйте ремонт или отклоните её.")
        if action=="accept":
            after.update(stage="work",planned_date=None)
            if before["stage"]=="planned" and before["planned_date"]>datetime.now(MOSCOW).date().isoformat() and not note:
                raise ApiError(400,"Укажите причину досрочного начала планового ремонта.")
        elif action=="wait":
            required(note,"Причина ожидания")
            after["stage"]="wait"
        elif action in ("transfer_department","transfer_shift"):
            required(note,"Что выполнено, что осталось и причина передачи")
            if action=="transfer_department":
                department=required(body.get("department"),"Участок")
                if department==row["department"] and before["stage"]!="review":
                    raise ApiError(400,"Для другой смены этого участка используйте передачу смене.")
                if not c.execute("SELECT 1 FROM departments WHERE name=?",(department,)).fetchone():
                    raise ApiError(400,"Участок не найден.")
                after["shift_id"]=None
            else:
                if row["department"]!=TO_DEPARTMENT:
                    raise ApiError(400,"Передача смене доступна только внутри участка заявочных ремонтов.")
                target=text(body.get("shiftId"))
                if target not in SHIFT_IDS and target!="":
                    raise ApiError(400,"Неизвестная смена.")
                if target==before["shift_id"] and before["stage"]!="review":
                    raise ApiError(400,"Заявка уже у этой смены.")
                after["shift_id"]=target or None
            if department==TO_DEPARTMENT and action=="transfer_department":
                target=text(body.get("shiftId"))
                if target and target not in SHIFT_IDS:
                    raise ApiError(400,"Неизвестная смена.")
                after["shift_id"]=target or None
            after.update(stage="incoming",planned_date=None)
        elif action=="review":
            required(note,"Вопрос и причина передачи руководству")
            after["stage"]="review"
        elif action=="plan":
            required(note,"Основание планового ремонта")
            value=required(body.get("plannedDate"),"Дата ремонта")
            try:
                parsed=date.fromisoformat(value)
            except ValueError:
                raise ApiError(400,"Некорректная дата ремонта.")
            if parsed<datetime.now(MOSCOW).date():
                raise ApiError(400,"Дата планового ремонта не может быть в прошлом.")
            department=text(body.get("department"),row["department"])
            if before["stage"]!="review" and department!=row["department"]:
                raise ApiError(400,"Участок планирует ремонт внутри своего участка.")
            if not c.execute("SELECT 1 FROM departments WHERE name=?",(department,)).fetchone():
                raise ApiError(400,"Участок не найден.")
            target=text(body.get("shiftId"),before["shift_id"] or "")
            if target and target not in SHIFT_IDS:
                raise ApiError(400,"Неизвестная смена.")
            after.update(stage="planned",planned_date=value,shift_id=(target or None) if department==TO_DEPARTMENT else None)
        elif action=="reject":
            required(note,"Причина отклонения")
            history=new_id()
            notes="Отклонено: "+note
            c.execute("""INSERT INTO repair_history(id,board,model,work_date,department,description,work_done,note,source,
                       external_source,external_id,created_at,updated_at,completed_by_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                      (history,row["board"],row["model"],datetime.now(MOSCOW).date().isoformat(),row["department"],
                       row["description"],"",notes,"отклонённая заявка",row["external_source"],row["external_id"],now_iso(),now_iso(),user["id"]))
            close(c,row,user,"rejected",note,history)
            c.execute("DELETE FROM requests WHERE id=?",(ident,))
            write_audit(c,user,"reject","request",ident,{"reason":note,"historyId":history})
            return {"historyId":history}
        elif action=="note":
            required(note,"Заметка")
        else:
            raise ApiError(400,"Неизвестное решение.")
        status={"incoming":"new","work":"in_progress","wait":"waiting","planned":"waiting","review":"waiting"}[after["stage"]]
        c.execute("UPDATE request_flow SET shift_id=?,stage=?,planned_date=?,version=version+1,legacy=0 WHERE request_id=?",
                  (after["shift_id"],after["stage"],after["planned_date"],ident))
        c.execute("UPDATE requests SET department=?,status=?,assigned_user_id=NULL,updated_at=? WHERE id=?",(department,status,now_iso(),ident))
        event(c,ident,user,action,note,before,after,row["department"],department)
        write_audit(c,user,action,"request",ident,{"note":note,"department":department,"shiftId":after["shift_id"],"plannedDate":after["planned_date"]})
        return {"id":ident}


def delete_note(ident,note_id,body,user):
    assert_permission(user,"editRequests")
    with transaction() as c:
        row=c.execute("SELECT * FROM requests WHERE id=?",(ident,)).fetchone()
        if row is None:
            raise ApiError(409,"Ремонт уже закрыт: его заметки доступны только для чтения.")
        assert_owner(c,row,user)
        before=ensure(c,row)
        if body.get("version")!=before["version"]:
            raise ApiError(409,"Заявка уже изменена. Обновите список.")
        note=c.execute("""
            SELECT e.*,m.author_id,m.deleted_at FROM request_events e
            LEFT JOIN request_note_meta m ON m.event_id=e.id
            WHERE e.id=? AND e.request_id=? AND e.action='note'""",(note_id,ident)).fetchone()
        if note is None or note["deleted_at"]:
            raise ApiError(404,"Заметка не найдена или уже удалена.")
        if user["role"]!="admin" and note["author_id"]!=user["id"]:
            raise ApiError(403,"Удалить заметку может её автор или администратор.")
        stamp=datetime.now(MOSCOW).isoformat(timespec="seconds")
        c.execute("""INSERT INTO request_note_meta(event_id,author_id,deleted_at,deleted_by) VALUES(?,?,?,?)
                     ON CONFLICT(event_id) DO UPDATE SET deleted_at=excluded.deleted_at,deleted_by=excluded.deleted_by""",
                  (note_id,note["author_id"],stamp,user["display_name"]))
        c.execute("UPDATE request_flow SET version=version+1 WHERE request_id=?",(ident,))
        event(c,ident,user,"note_deleted","Заметка удалена.",before,flow(c,ident),row["department"],row["department"])
        write_audit(c,user,"delete_note","request",ident,{"noteId":note_id})
    return {"ok":True}

