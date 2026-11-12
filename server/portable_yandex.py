from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from portable_core import connect, new_id, now_iso, text, transaction, TO_DEPARTMENT
import portable_workflow as workflow


CONFIG_PATH = Path(__file__).resolve().parent / "yandex-forms.config.json"
API_ROOT = "https://api.forms.yandex.net"


def _array(config: dict[str, Any], name: str, fallback: list[str]) -> list[str]:
    value=config.get(name)
    return list(value) if isinstance(value,list) else list(fallback)


def _forms(config: dict[str, Any]) -> list[dict[str, Any]]:
    defaults_board=["Номер борта","Борт","Бортовой номер"]
    defaults_description=["Описание проблемы","Неисправность","Описание неисправности","Что неисправно"]
    defaults_work=["Выполненные работы","Выполненная работа","Что выполнено","Работы","Описание выполненных работ"]
    sources=config.get("forms") if isinstance(config.get("forms"),list) and config["forms"] else [config]
    result=[]
    for source in sources:
        survey_id=text(source.get("surveyId",config.get("surveyId")))
        if not survey_id: continue
        kind=text(source.get("type",source.get("kind","request"))).casefold()
        kind="history" if kind in ("history","completed","complete","done","repairhistory","repair_history") else "request"
        result.append({
          "name":text(source.get("name"),"Выполненные работы" if kind=="history" else "Заявки на ремонт"),
          "type":kind,"surveyId":survey_id,"sourceKey":f"yandex_forms:{survey_id}",
          "department":text(source.get("department",config.get("department")),"УЗР"),
          "createdBy":text(source.get("createdBy",config.get("createdBy")),"Яндекс Форма"),
          "source":text(source.get("source"),text(source.get("createdBy",config.get("createdBy")),"Яндекс Форма")),
          "pageSize":int(source.get("pageSize",config.get("pageSize",50))),
          "boardFields":_array(source,"boardFields",_array(config,"boardFields",defaults_board)),
          "descriptionFields":_array(source,"descriptionFields",_array(config,"descriptionFields",defaults_description)),
          "workDoneFields":_array(source,"workDoneFields",_array(config,"workDoneFields",defaults_work)),
        })
    return result


def _answer_text(value: Any) -> str:
    if value is None:return ""
    if isinstance(value,list):return ", ".join(filter(None,(_answer_text(item) for item in value)))
    if isinstance(value,dict):
        for key in ("label","value","text","id"):
            if key in value:return _answer_text(value[key])
    return str(value).strip()


def _key(value: Any) -> str:
    return re.sub(r"\s+"," ",str(value or "")).strip().casefold()


def _field(answer:dict[str,Any],columns:list[dict[str,Any]],names:list[str]) -> str:
    wanted={_key(name) for name in names}
    for index,item in enumerate(answer.get("data") or []):
        keys={_key(item.get("id"))}
        if index<len(columns):
            keys.update(_key(columns[index].get(name)) for name in ("text","label","id","slug"))
        if wanted & keys:return _answer_text(item.get("value"))
    return ""


def _board(value:str) -> str:
    match=re.search(r"\d{4}",value.strip())
    return match.group(0) if match else value.strip()


def _created(answer:dict[str,Any]) -> str:
    value=text(answer.get("created"))
    try:return datetime.fromisoformat(value.replace("Z","+00:00")).astimezone().replace(tzinfo=None,microsecond=0).isoformat()
    except Exception:return now_iso()


def _import_answer(answer:dict[str,Any],columns:list[dict[str,Any]],form:dict[str,Any]) -> str:
    external_id=text(answer.get("id"))
    if not external_id:return "skipped"
    with transaction() as connection:
        department = form["department"] if form["type"]=="history" else TO_DEPARTMENT
        connection.execute(
            "INSERT OR IGNORE INTO departments(name,sort_order) VALUES(?,99)",
            (department,),
        )
        if connection.execute("SELECT 1 FROM requests WHERE external_source=? AND external_id=? UNION ALL SELECT 1 FROM repair_history WHERE external_source=? AND external_id=? LIMIT 1",
                              (form["sourceKey"],external_id,form["sourceKey"],external_id)).fetchone():return "duplicate"
        board=_board(_field(answer,columns,form["boardFields"])); description=_field(answer,columns,form["descriptionFields"]).strip()
        work=_field(answer,columns,form["workDoneFields"]).strip()
        if form["type"]=="history":
            description=description or work; work=work or description
            if not board or not work:return "skipped"
        elif not board or not description:return "skipped"
        fleet=connection.execute("SELECT model FROM fleet WHERE board=?",(board,)).fetchone(); model=fleet["model"] if fleet else "Модель не указана"
        connection.execute("INSERT INTO fleet(board,model,is_active) VALUES(?,?,1) ON CONFLICT(board) DO UPDATE SET is_active=1",(board,model))
        created=_created(answer)
        if form["type"]=="history":
            connection.execute("""
              INSERT INTO repair_history(id,board,model,work_date,department,description,work_done,source,external_source,external_id,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,(new_id(),board,model,created[:10],form["department"],description,work,form["source"],form["sourceKey"],external_id,created,created))
        else:
            ident = new_id()
            connection.execute("""
              INSERT INTO requests(id,board,model,department,description,created_by,created_at,status,updated_at,external_source,external_id)
              VALUES(?,?,?,?,?,?,?,'new',?,?,?)
            """,(ident,board,model,department,description,form["createdBy"],created,created,form["sourceKey"],external_id))
            workflow.intake(connection,ident)
        return "imported"


def _get_json(url:str,headers:dict[str,str]) -> dict[str,Any]:
    request=urllib.request.Request(url,headers=headers)
    with urllib.request.urlopen(request,timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def sync_once() -> None:
    if not CONFIG_PATH.exists():return
    config=json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    if not config.get("enabled"):return
    token=text(config.get("oauthToken")); org=text(config.get("orgId"))
    if not token or not org:return
    headers={"Authorization":f"OAuth {token}",text(config.get("orgHeader"),"X-Org-Id"):org}
    for form in _forms(config):
        with connect() as connection:
            row=connection.execute("SELECT last_answer_id FROM yandex_checkpoints WHERE source_key=?",(form["sourceKey"],)).fetchone()
            checkpoint=row["last_answer_id"] if row else None
        url=f"{API_ROOT}/v1/surveys/{form['surveyId']}/answers?page_size={max(1,form['pageSize'])}"
        newest=None; imported=0; error=""
        try:
            reached=False
            while url and not reached:
                payload=_get_json(url,headers); columns=payload.get("columns") or []
                for answer in payload.get("answers") or []:
                    answer_id=text(answer.get("id")); newest=newest or answer_id
                    if checkpoint and answer_id==checkpoint: reached=True;break
                    if _import_answer(answer,columns,form)=="imported":imported+=1
                next_url=((payload.get("next") or {}).get("next_url") or "")
                url=(next_url if next_url.startswith("http") else API_ROOT+next_url) if next_url and not reached else ""
        except Exception as exc:
            error=str(exc)
        with transaction() as connection:
            connection.execute("""
              INSERT INTO yandex_checkpoints(source_key,last_answer_id,last_sync_at,last_imported_count,last_error)
              VALUES(?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET last_answer_id=excluded.last_answer_id,last_sync_at=excluded.last_sync_at,
                last_imported_count=excluded.last_imported_count,last_error=excluded.last_error
            """,(form["sourceKey"],newest or checkpoint,now_iso(),imported,error))


def worker(stop_event:threading.Event) -> None:
    while not stop_event.is_set():
        delay=60
        try:
            if CONFIG_PATH.exists():
                config=json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"));delay=max(5,int(config.get("pollIntervalSeconds") or 60))
            sync_once()
        except Exception:
            pass
        stop_event.wait(delay)
