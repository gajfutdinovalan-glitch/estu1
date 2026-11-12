from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from portable_core import (
    ApiError,
    SERVER_DIR,
    assert_module,
    assert_permission,
    board_sort_key,
    connect,
    new_id,
    now_iso,
    parse_iso_date,
    protect_secret,
    required,
    text,
    today_iso,
    transaction,
    unprotect_secret,
    write_audit,
)


def _mail_row(connection):
    return connection.execute("""
      SELECT c.*,s.mailbox_key,s.last_uid,s.last_check_at,s.last_success_at,s.last_error,s.last_imported_count,s.trigger_requested
      FROM nav_mail_config c CROSS JOIN nav_mail_state s WHERE c.id=1 AND s.id=1
    """).fetchone()


def mail_public(user: dict[str, Any]) -> dict[str, Any]:
    assert_module(user,"navcontrol")
    with connect() as connection:
        row=_mail_row(connection)
        return {"imapHost":row["imap_host"],"imapPort":row["imap_port"],"useSsl":bool(row["use_ssl"]),
                "username":row["username"],"hasPassword":bool(row["password_protected"]),"mailFolder":row["mail_folder"],
                "senderFilter":row["sender_filter"],"subjectFilter":row["subject_filter"],"depotName":row["depot_name"],
                "pollMinutes":row["poll_minutes"],"morningCutoffHour":row["morning_cutoff_hour"],"autoSync":bool(row["auto_sync"]),
                "lastCheckAt":row["last_check_at"],"lastSuccessAt":row["last_success_at"],"lastError":row["last_error"],
                "lastImportedCount":row["last_imported_count"]}


def save_mail(body: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    assert_permission(user,"configureNavMail"); assert_module(user,"navcontrol")
    with transaction() as connection:
        current=_mail_row(connection)
        protected=current["password_protected"]
        if text(body.get("password")):
            protected=protect_secret(str(body["password"]))
        if body.get("clearPassword"):
            protected=""
        host=text(body.get("imapHost")); username=text(body.get("username")); folder=text(body.get("mailFolder"),"INBOX")
        try:
            port=int(body.get("imapPort") or 993); poll=int(body.get("pollMinutes") or 5); cutoff=int(body.get("morningCutoffHour") or 12)
        except (TypeError,ValueError) as exc:
            raise ApiError(400,"Некорректные числовые настройки почты.") from exc
        if not 1<=port<=65535: raise ApiError(400,"Некорректный порт IMAP.")
        if not 1<=poll<=1440: raise ApiError(400,"Период проверки должен быть от 1 до 1440 минут.")
        if not 0<=cutoff<=23: raise ApiError(400,"Час разделения должен быть от 0 до 23.")
        auto=bool(body.get("autoSync"))
        if auto and (not host or not username or not protected):
            raise ApiError(400,"Для автозагрузки заполните сервер, имя пользователя и пароль почты.")
        mailbox_key=f"{host.casefold()}|{username.casefold()}|{folder.casefold()}"
        connection.execute("""
          UPDATE nav_mail_config SET imap_host=?,imap_port=?,use_ssl=?,username=?,password_protected=?,mail_folder=?,
            sender_filter=?,subject_filter=?,depot_name=?,poll_minutes=?,morning_cutoff_hour=?,auto_sync=?,updated_at=?,updated_by_user_id=? WHERE id=1
        """,(host,port,int(bool(body.get("useSsl",True))),username,protected,folder,text(body.get("senderFilter")),
              text(body.get("subjectFilter"),"User metro"),text(body.get("depotName"),"Троллейбусное Депо №2"),poll,cutoff,int(auto),now_iso(),user["id"]))
        if current["mailbox_key"]!=mailbox_key:
            connection.execute("UPDATE nav_mail_state SET mailbox_key=?,last_uid=0,last_check_at=NULL,last_success_at=NULL,last_error='',last_imported_count=0 WHERE id=1",(mailbox_key,))
        write_audit(connection,user,"update","navigation-mail-config","1",{"autoSync":auto,"host":host,"username":username})
    return mail_public(user)


def worker_config() -> dict[str, Any]:
    with transaction() as connection:
        row=_mail_row(connection)
        trigger=bool(row["trigger_requested"])
        if trigger:
            connection.execute("UPDATE nav_mail_state SET trigger_requested=0 WHERE id=1")
        return {"imapHost":row["imap_host"],"imapPort":row["imap_port"],"useSsl":bool(row["use_ssl"]),
                "username":row["username"],"password":unprotect_secret(row["password_protected"]),"mailFolder":row["mail_folder"],
                "senderFilter":row["sender_filter"],"subjectFilter":row["subject_filter"],"depotName":row["depot_name"],
                "pollMinutes":row["poll_minutes"],"morningCutoffHour":row["morning_cutoff_hour"],"autoSync":bool(row["auto_sync"]),
                "lastUid":row["last_uid"],"trigger":trigger}


def worker_state(body: dict[str, Any]) -> None:
    success=bool(body.get("success")); error=text(body.get("error")); imported=int(body.get("imported") or 0)
    with transaction() as connection:
        connection.execute("""
          UPDATE nav_mail_state SET last_uid=?,last_check_at=?,last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,
            last_error=?,last_imported_count=? WHERE id=1
        """,(int(body.get("lastUid") or 0),now_iso(),int(success),now_iso(),error,imported))
        connection.execute("INSERT INTO nav_sync_log(created_at,level,message) VALUES(?,?,?)",
                          (now_iso(),"success" if success else "error",f"Почта проверена. Импортировано отчётов: {imported}" if success else f"Ошибка проверки почты: {error}"))


def request_mail_sync(user: dict[str, Any]) -> None:
    assert_permission(user,"manageNavControl"); assert_module(user,"navcontrol")
    with transaction() as connection:
        connection.execute("UPDATE nav_mail_state SET trigger_requested=1 WHERE id=1")
        connection.execute("INSERT INTO nav_sync_log(created_at,level,message) VALUES(?,?,?)",(now_iso(),"info","Запрошена ручная проверка почты."))


def _parse_workbook(data: bytes, filename: str, mode: str, fallback_hour: int) -> dict[str, Any]:
    suffix=Path(filename).suffix or ".xlsx"
    with tempfile.NamedTemporaryFile(suffix=suffix,delete=False) as handle:
        handle.write(data); path=Path(handle.name)
    try:
        result=subprocess.run([sys.executable,str(SERVER_DIR/"navcontrol"/"parse_cli.py"),str(path),"--mode",mode,"--fallback-hour",str(fallback_hour),"--base64"],
                              capture_output=True,text=True,encoding="utf-8",timeout=120,check=False)
        if result.returncode:
            raise ApiError(400,(result.stderr or "Не удалось разобрать XLSX.").strip())
        return json.loads(base64.b64decode(result.stdout.strip()).decode("utf-8"))
    finally:
        path.unlink(missing_ok=True)


def import_workbook(body: dict[str, Any], user: dict[str, Any] | None, from_worker: bool=False) -> dict[str, Any]:
    if not from_worker:
        assert_permission(user,"manageNavControl"); assert_module(user,"navcontrol")
    filename=required(body.get("filename"),"Файл")
    if not filename.casefold().endswith(".xlsx"): raise ApiError(400,"Поддерживаются только файлы XLSX.")
    try: data=base64.b64decode(str(body.get("contentBase64") or ""),validate=True)
    except Exception as exc: raise ApiError(400,"Не удалось прочитать содержимое файла.") from exc
    if len(data)>25*1024*1024: raise ApiError(400,"Размер XLSX не должен превышать 25 МБ.")
    mode=text(body.get("mode"),"auto")
    if mode not in ("auto","morning","evening","both"): mode="auto"
    parsed=_parse_workbook(data,filename,mode,int(body.get("fallbackHour") or datetime.now().hour))
    if body.get("reportDate"):
        report_date=parse_iso_date(body["reportDate"]).isoformat(); date_reason="дата отчёта указана при загрузке"
    elif parsed.get("workbookDate"):
        report_date=parse_iso_date(parsed["workbookDate"]).isoformat(); date_reason="дата отчёта прочитана из содержимого XLSX"
    elif body.get("emailDate"):
        report_date=str(body["emailDate"])[:10]; date_reason="дата в XLSX не найдена, использована дата письма"
    else:
        report_date=today_iso(); date_reason="дата в XLSX не найдена, использована дата загрузки"
    reason=f"{parsed.get('detectionReason','')}; {date_reason}".strip("; ")
    source="email" if from_worker else "manual"
    unknown:set[str]=set(); imported=duplicates=0
    with transaction() as connection:
        active={row["board"] for row in connection.execute("SELECT board FROM fleet WHERE is_active=1")}
        for period_data in parsed.get("periods") or []:
            period=period_data.get("period")
            existing=connection.execute("SELECT id FROM nav_reports WHERE sha256=? AND period=? AND report_date=?",
                                        (parsed.get("sha256"),period,report_date)).fetchone()
            if existing:
                duplicates+=1; continue
            connection.execute("UPDATE nav_reports SET is_active=0 WHERE report_date=? AND period=? AND is_active=1",(report_date,period))
            cursor=connection.execute("""
              INSERT INTO nav_reports(report_date,period,source,file_name,sha256,email_uid,email_subject,email_from,email_date,
                                      imported_at,imported_by_user_id,warning,detection_reason,is_active)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)
            """,(report_date,period,source,filename,parsed.get("sha256") or "",body.get("emailUid"),text(body.get("emailSubject")),
                  text(body.get("emailFrom")),body.get("emailDate"),now_iso(),user["id"] if user else None,"; ".join(parsed.get("warnings") or []),reason))
            report_id=cursor.lastrowid
            for observation in period_data.get("observations") or []:
                board=text(observation.get("board"))
                if board not in active:
                    if board: unknown.add(board)
                    continue
                connection.execute("INSERT OR REPLACE INTO nav_observations(report_id,board,route,schedule,comment,raw_row) VALUES(?,?,?,?,?,?)",
                                  (report_id,board,text(observation.get("route")),text(observation.get("schedule")),text(observation.get("comment")),int(observation.get("raw_row") or observation.get("rawRow") or 0)))
            imported+=1
        level="success" if imported else "info"
        connection.execute("INSERT INTO nav_sync_log(created_at,level,message) VALUES(?,?,?)",
                          (now_iso(),level,f"{report_date}: файл «{filename}» обработан. Новых периодов: {imported}, повторов: {duplicates}."))
        if user:
            write_audit(connection,user,"import","navigation-report",report_date,{"file":filename,"imported":imported,"periods":[p.get("period") for p in parsed.get("periods") or []]})
    sync_attention(force=True)
    return {"imported":imported,"duplicates":duplicates,"unknownBoards":sorted(unknown,key=board_sort_key),"reportDate":report_date,"reason":reason}


_last_attention_sync: datetime | None = None


def _daily_status(connection, board: str, day: str) -> str:
    reports={row["period"]:row["id"] for row in connection.execute("SELECT id,period FROM nav_reports WHERE report_date=? AND is_active=1",(day,))}
    if not reports.get("morning") or not reports.get("evening"): return "incomplete"
    morning=connection.execute("SELECT 1 FROM nav_observations WHERE report_id=? AND board=?",(reports["morning"],board)).fetchone() is not None
    evening=connection.execute("SELECT 1 FROM nav_observations WHERE report_id=? AND board=?",(reports["evening"],board)).fetchone() is not None
    if morning and evening:return "red"
    if morning or evening:return "yellow"
    return "green"


def sync_attention(force: bool=False) -> None:
    global _last_attention_sync
    if not force and _last_attention_sync and (datetime.now()-_last_attention_sync).total_seconds()<30:return
    with transaction() as connection:
        latest_row=connection.execute("SELECT MAX(report_date) latest FROM nav_reports WHERE is_active=1").fetchone()
        if not latest_row["latest"]: _last_attention_sync=datetime.now(); return
        latest=parse_iso_date(latest_row["latest"]); days=[(latest-timedelta(days=offset)).isoformat() for offset in range(29,-1,-1)]
        for fleet in connection.execute("SELECT board FROM fleet WHERE is_active=1"):
            board=fleet["board"]; statuses=[_daily_status(connection,board,day) for day in days]
            complete=[status for status in statuses if status!="incomplete"]
            red_percent=round(100*complete.count("red")/len(complete),2) if complete else 0
            yellow_percent=round(100*complete.count("yellow")/len(complete),2) if complete else 0
            red_streak=run=0
            for status in statuses:
                run=run+1 if status=="red" else 0; red_streak=max(red_streak,run)
            healthy=0
            for status in reversed(statuses):
                if status=="green": healthy+=1
                else: break
            active=connection.execute("SELECT * FROM nav_attention_cases WHERE board=? AND is_active=1",(board,)).fetchone()
            if active:
                if healthy>=7:
                    connection.execute("UPDATE nav_attention_cases SET red_percent=?,yellow_percent=?,red_streak=?,healthy_streak=?,last_evaluated_at=?,last_report_date=?,is_active=0,closed_at=?,closed_reason=? WHERE id=?",
                                      (red_percent,yellow_percent,red_streak,healthy,now_iso(),latest.isoformat(),now_iso(),"Автоматически: 7 исправных дней подряд",active["id"]))
                else:
                    connection.execute("UPDATE nav_attention_cases SET red_percent=?,yellow_percent=?,red_streak=?,healthy_streak=?,last_evaluated_at=?,last_report_date=? WHERE id=?",
                                      (red_percent,yellow_percent,red_streak,healthy,now_iso(),latest.isoformat(),active["id"]))
                continue
            reasons=[]
            if red_streak>=2: reasons.append("полностью красные отметки не менее 2 дней подряд")
            if red_percent>30: reasons.append(f"красных дней {red_percent}% за последние 30 дней")
            if yellow_percent>40: reasons.append(f"жёлтых дней {yellow_percent}% за последние 30 дней")
            if statuses[-1] in ("red","yellow") and reasons:
                now=now_iso(); case_id=new_id()
                connection.execute("INSERT INTO nav_attention_cases(id,board,opened_at,opened_report_date,trigger_reason,red_percent,yellow_percent,red_streak,healthy_streak,is_active,last_evaluated_at,last_report_date) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)",
                                  (case_id,board,now,latest.isoformat(),"; ".join(reasons),red_percent,yellow_percent,red_streak,healthy,now,latest.isoformat()))
    _last_attention_sync=datetime.now()


def attention_cases(connection,user:dict[str,Any]) -> list[dict[str,Any]]:
    can_manage=True
    try: assert_permission(user,"manageNavControl")
    except ApiError: can_manage=False
    result=[]
    for row in connection.execute("""
      SELECT c.*,f.model FROM nav_attention_cases c JOIN fleet f ON f.board=c.board
      WHERE c.is_active=1 ORDER BY c.opened_at,c.board
    """):
        events=connection.execute("SELECT description,work_done,note,created_at FROM repair_history WHERE board=? AND external_source='navigation-control' ORDER BY created_at DESC,id DESC",(row["board"],)).fetchall()
        latest=events[0] if events else None
        result.append({"id":row["id"],"board":row["board"],"model":row["model"],"openedAt":row["opened_at"],
          "openedReportDate":row["opened_report_date"],"triggerReason":row["trigger_reason"],"redPercent":row["red_percent"],
          "yellowPercent":row["yellow_percent"],"redStreak":row["red_streak"],"healthyStreak":row["healthy_streak"],
          "lastReportDate":row["last_report_date"],"eventCount":len(events),
          "latestText":(latest["work_done"] or latest["note"] or latest["description"]) if latest else "",
          "latestAt":latest["created_at"] if latest else "","canManage":can_manage})
    return result


def dashboard(from_value:str,to_value:str,user:dict[str,Any]) -> dict[str,Any]:
    assert_module(user,"navcontrol"); sync_attention()
    to_date=parse_iso_date(to_value,date.today()); from_date=parse_iso_date(from_value,to_date-timedelta(days=13))
    if from_date>to_date: from_date,to_date=to_date,from_date
    if (to_date-from_date).days>92: from_date=to_date-timedelta(days=92)
    days=[]; cursor=from_date
    while cursor<=to_date: days.append(cursor.isoformat()); cursor+=timedelta(days=1)
    with connect() as connection:
        fleet=sorted(connection.execute("SELECT board,model FROM fleet WHERE is_active=1").fetchall(),key=lambda row:board_sort_key(row["board"]))
        reports=connection.execute("SELECT * FROM nav_reports ORDER BY report_date DESC,is_active DESC,CASE period WHEN 'morning' THEN 0 ELSE 1 END,id DESC LIMIT 200").fetchall()
        period_reports={(row["report_date"],row["period"]):row for row in reports if row["is_active"] and from_date.isoformat()<=row["report_date"]<=to_date.isoformat()}
        boards=[]
        for vehicle in fleet:
            entries=[]; red=yellow=complete=longest=run=0
            for day in days:
                morning=period_reports.get((day,"morning")); evening=period_reports.get((day,"evening"))
                def observation(report):
                    return connection.execute("SELECT * FROM nav_observations WHERE report_id=? AND board=?",(report["id"],vehicle["board"])).fetchone() if report else None
                mo=observation(morning); ev=observation(evening)
                if morning and evening:
                    if mo and ev: status="red";red+=1;complete+=1;run+=1
                    elif mo: status="yellow_morning";yellow+=1;complete+=1;run+=1
                    elif ev: status="yellow_evening";yellow+=1;complete+=1;run+=1
                    else: status="green";complete+=1;run=0
                elif morning and mo: status="yellow_morning";yellow+=1;run+=1
                elif evening and ev: status="yellow_evening";yellow+=1;run+=1
                else: status="incomplete";run=0
                longest=max(longest,run)
                entries.append({"date":day,"status":status,"morning":bool(mo),"evening":bool(ev),
                  "morningComment":mo["comment"] if mo else "","eveningComment":ev["comment"] if ev else "",
                  "morningRoute":mo["route"] if mo else "","eveningRoute":ev["route"] if ev else ""})
            streak=0
            for entry in reversed(entries):
                if entry["status"]=="incomplete": continue
                if entry["status"] in ("red","yellow_morning","yellow_evening"): streak+=1
                else: break
            boards.append({"board":vehicle["board"],"model":vehicle["model"],"entries":entries,"red":red,"yellow":yellow,
              "completeDays":complete,"currentStreak":streak,"longestStreak":longest,"problemPercent":round((red+yellow)*100/complete,1) if complete else 0,
              "score":red*2+yellow+streak})
        active_periods=[row for row in period_reports.values()]
        latest=max((row["report_date"] for row in active_periods),default=(days[-1] if days else None))
        latest_index=days.index(latest) if latest in days else max(0,len(days)-1)
        latest_entries=[board["entries"][latest_index] for board in boards] if days else []
        report_items=[{"Id":row["id"],"ReportDate":row["report_date"],"Period":row["period"],"Source":row["source"],
          "FileName":row["file_name"],"ImportedAt":row["imported_at"],"Warning":row["warning"],"DetectionReason":row["detection_reason"],"IsActive":bool(row["is_active"])} for row in reports]
        logs=[{"CreatedAt":row["created_at"],"Level":row["level"],"Message":row["message"]} for row in connection.execute("SELECT * FROM nav_sync_log ORDER BY id DESC LIMIT 20")]
        return {"from":from_date.isoformat(),"to":to_date.isoformat(),"days":days,"boards":boards,
          "stats":{"reportDate":latest,"fleet":len(fleet),"working":sum(e["status"]=="green" for e in latest_entries),
                   "problem":sum(e["status"] in ("red","yellow_morning","yellow_evening") for e in latest_entries),
                   "incomplete":sum(e["status"]=="incomplete" for e in latest_entries)},
          "attention":attention_cases(connection,user),"reports":report_items,"logs":logs,"mail":mail_public(user)}


def attention_history(case_id:str,user:dict[str,Any]) -> dict[str,Any] | None:
    assert_module(user,"navcontrol")
    with connect() as connection:
        case=connection.execute("SELECT board FROM nav_attention_cases WHERE id=?",(case_id,)).fetchone()
        if case is None:return None
        items=[]
        for row in connection.execute("""
          SELECT h.*,u.display_name created_by FROM repair_history h LEFT JOIN users u ON u.id=h.completed_by_user_id
          WHERE h.board=? AND h.external_source='navigation-control' ORDER BY h.created_at DESC,h.id DESC
        """,(case["board"],)):
            items.append({"Id":row["id"],"Board":row["board"],"Description":row["description"],"WorkDone":row["work_done"],
                          "Note":row["note"],"Source":row["source"],"WorkDate":row["work_date"],"CreatedAt":row["created_at"],"CreatedBy":row["created_by"]})
        return {"board":case["board"],"items":items}


def attention_action(case_id:str,body:dict[str,Any],user:dict[str,Any],entry_type:str) -> dict[str,Any] | None:
    assert_permission(user,"manageNavControl"); assert_module(user,"navcontrol")
    value=required(body.get("text"),"Принятые меры" if entry_type=="measure" else "Заметка")
    with transaction() as connection:
        case=connection.execute("SELECT c.*,f.model FROM nav_attention_cases c JOIN fleet f ON f.board=c.board WHERE c.id=? AND c.is_active=1",(case_id,)).fetchone()
        if case is None:return None
        department=text(user.get("department"))
        if not department:
            row=connection.execute("SELECT name FROM departments ORDER BY CASE WHEN lower(name) LIKE '%электрон%' OR name LIKE '%РЭЛ%' THEN 0 ELSE 1 END,sort_order,id LIMIT 1").fetchone()
            department=row["name"] if row else ""
        history_id=new_id(); now=now_iso()
        connection.execute("""
          INSERT INTO repair_history(id,board,model,work_date,department,description,work_done,note,source,external_source,external_id,created_at,updated_at,completed_by_user_id)
          VALUES(?,?,?,?,?,?,?,?,?,'navigation-control',?,?,?,?)
        """,(history_id,case["board"],case["model"],today_iso(),department,
              f"Неисправность навигации: {case['trigger_reason']}" if entry_type=="measure" else f"Заметка контроля навигации: {value}",
              value if entry_type=="measure" else None,value if entry_type=="note" else "Карточка закрыта после принятых мер.",
              "Создано автоматически сервисом контроля навигации",f"{case_id}:{history_id}",now,now,user["id"]))
        if entry_type=="measure":
            connection.execute("UPDATE nav_attention_cases SET is_active=0,closed_at=?,closed_reason='Выполнены принятые меры',closed_by_user_id=?,last_evaluated_at=? WHERE id=?",(now,user["id"],now,case_id))
        write_audit(connection,user,"complete" if entry_type=="measure" else "note","navigation-attention",case_id,{"board":case["board"],"historyId":history_id,"text":value})
        return {"id":history_id,"board":case["board"]}


def dismiss_attention(case_id:str,body:dict[str,Any],user:dict[str,Any]) -> bool:
    assert_permission(user,"manageNavControl"); assert_module(user,"navcontrol")
    reason=text(body.get("reason"),"Снято с контроля вручную")
    with transaction() as connection:
        cursor=connection.execute("UPDATE nav_attention_cases SET is_active=0,closed_at=?,closed_reason=?,closed_by_user_id=?,last_evaluated_at=? WHERE id=? AND is_active=1",(now_iso(),reason,user["id"],now_iso(),case_id))
        if not cursor.rowcount:return False
        write_audit(connection,user,"dismiss","navigation-attention",case_id,{"reason":reason});return True
