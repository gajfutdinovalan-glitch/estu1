from __future__ import annotations

import hashlib
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CORE_NS = {"dcterms": "http://purl.org/dc/terms/"}

MONTHS_RU = {
    "января": 1,
    "январь": 1,
    "февраля": 2,
    "февраль": 2,
    "марта": 3,
    "март": 3,
    "апреля": 4,
    "апрель": 4,
    "мая": 5,
    "май": 5,
    "июня": 6,
    "июнь": 6,
    "июля": 7,
    "июль": 7,
    "августа": 8,
    "август": 8,
    "сентября": 9,
    "сентябрь": 9,
    "октября": 10,
    "октябрь": 10,
    "ноября": 11,
    "ноябрь": 11,
    "декабря": 12,
    "декабрь": 12,
}


@dataclass(slots=True)
class Observation:
    board: int
    route: str = ""
    schedule: str = ""
    comment: str = ""
    raw_row: int = 0


@dataclass(slots=True)
class ParsedWorkbook:
    filename: str
    sha256: str
    workbook_date: date | None
    workbook_date_source: str = ""
    workbook_modified: datetime | None = None
    morning: list[Observation] = field(default_factory=list)
    evening: list[Observation] = field(default_factory=list)
    morning_sheet_found: bool = False
    evening_sheet_found: bool = False
    warnings: list[str] = field(default_factory=list)


def _norm(value: Any) -> str:
    text = str(value or "").replace('"', " ").replace("ё", "е").lower()
    text = re.sub(r"[\u00a0\t\r\n]+", " ", text)
    return " ".join(text.split())


def _col_num(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref.upper())
    value = 0
    for ch in (letters.group(0) if letters else ""):
        value = value * 26 + ord(ch) - 64
    return value


def _as_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def _board(value: Any) -> int | None:
    num = _as_number(value)
    if num is not None and num.is_integer():
        n = int(num)
        if 1000 <= n <= 9999:
            return n
    match = re.search(r"(?<!\d)(\d{4})(?!\d)", str(value or ""))
    return int(match.group(1)) if match else None


def _parse_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    result: list[str] = []
    for si in root.findall(f"{{{MAIN_NS}}}si"):
        result.append("".join((node.text or "") for node in si.iter(f"{{{MAIN_NS}}}t")))
    return result


def _sheet_paths(zf: zipfile.ZipFile) -> dict[str, str]:
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {
        rel.attrib["Id"]: rel.attrib["Target"]
        for rel in rels.findall(f"{{{PKG_REL_NS}}}Relationship")
    }
    result: dict[str, str] = {}
    sheets = wb.find(f"{{{MAIN_NS}}}sheets")
    if sheets is None:
        return result
    for sheet in sheets:
        name = sheet.attrib.get("name", "")
        rid = sheet.attrib.get(f"{{{REL_NS}}}id")
        target = rel_map.get(rid or "", "")
        if not target:
            continue
        if target.startswith("/"):
            target = target.lstrip("/")
        elif not target.startswith("xl/"):
            target = "xl/" + target
        result[name] = target.replace("\\", "/")
    return result


def _read_sheet(zf: zipfile.ZipFile, path: str, shared: list[str]) -> list[dict[int, Any]]:
    root = ET.fromstring(zf.read(path))
    rows: list[dict[int, Any]] = []
    for row in root.iter(f"{{{MAIN_NS}}}row"):
        data: dict[int, Any] = {0: int(row.attrib.get("r", "0"))}
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            ref = cell.attrib.get("r", "")
            col = _col_num(ref)
            kind = cell.attrib.get("t")
            value_node = cell.find(f"{{{MAIN_NS}}}v")
            inline = cell.find(f"{{{MAIN_NS}}}is")
            value: Any = None
            if inline is not None:
                value = "".join((t.text or "") for t in inline.iter(f"{{{MAIN_NS}}}t"))
            elif value_node is not None:
                raw = value_node.text or ""
                if kind == "s":
                    try:
                        value = shared[int(raw)]
                    except (ValueError, IndexError):
                        value = raw
                elif kind in {"str", "inlineStr"}:
                    value = raw
                elif kind == "b":
                    value = raw == "1"
                else:
                    try:
                        number = float(raw)
                        value = int(number) if number.is_integer() else number
                    except ValueError:
                        value = raw
            data[col] = value
        rows.append(data)
    return rows


def _core_modified(zf: zipfile.ZipFile) -> datetime | None:
    try:
        root = ET.fromstring(zf.read("docProps/core.xml"))
        modified = root.find("dcterms:modified", CORE_NS)
        if modified is not None and modified.text:
            return datetime.fromisoformat(modified.text.replace("Z", "+00:00"))
    except (KeyError, ValueError, ET.ParseError):
        pass
    return None


def detect_date_from_text(text: str) -> date | None:
    value = _norm(text)
    patterns = [
        r"(?<!\d)(20\d{2})[-_./](\d{1,2})[-_./](\d{1,2})(?!\d)",
        r"(?<!\d)(\d{1,2})[-_./](\d{1,2})[-_./](20\d{2})(?!\d)",
        r"(?<!\d)(\d{1,2})[-_./](\d{1,2})[-_./](\d{2})(?!\d)",
    ]
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, value)
        if not match:
            continue
        parts = [int(x) for x in match.groups()]
        try:
            if index == 0:
                return date(parts[0], parts[1], parts[2])
            year = parts[2] if parts[2] >= 100 else 2000 + parts[2]
            return date(year, parts[1], parts[0])
        except ValueError:
            continue

    months = "|".join(sorted(MONTHS_RU, key=len, reverse=True))
    match = re.search(rf"(?<!\d)(\d{{1,2}})\s+({months})\s+(20\d{{2}})(?!\d)", value)
    if match:
        try:
            return date(int(match.group(3)), MONTHS_RU[match.group(2)], int(match.group(1)))
        except ValueError:
            pass
    return None


def _date_from_rows(sheet_rows: dict[str, list[dict[int, Any]]]) -> date | None:
    candidates: list[date] = []
    for rows in sheet_rows.values():
        for row in rows[:10]:
            for col, value in row.items():
                if col == 0 or value in (None, ""):
                    continue
                detected = detect_date_from_text(str(value))
                if detected:
                    candidates.append(detected)
    if not candidates:
        return None
    # The same report date normally appears on several sheets. Pick the most frequent one.
    return max(set(candidates), key=lambda item: (candidates.count(item), item))


def _find_header(rows: list[dict[int, Any]], words: tuple[str, ...], max_rows: int = 15) -> int:
    for row in rows[:max_rows]:
        text = " | ".join(_norm(v) for k, v in row.items() if k)
        if all(word in text for word in words):
            return int(row.get(0, 0))
    return 0


def _header_columns(rows: list[dict[int, Any]], start: int, end: int) -> dict[str, int]:
    result: dict[str, int] = {}
    for row in rows:
        r = int(row.get(0, 0))
        if not start <= r <= end:
            continue
        for col, value in row.items():
            if col == 0:
                continue
            text = _norm(value)
            if "предприят" in text or text == "депо":
                result.setdefault("depot", col)
            if "маршрут" in text or "№ мар" in text or text in {"марш.", "марш"}:
                result.setdefault("route", col)
            if "график" in text:
                result.setdefault("schedule", col)
            if "гар" in text and ("№" in str(value) or "номер" in text or text.startswith("гар")):
                result.setdefault("board", col)
            if text == "бк" or text.endswith(" бк") or "бортовой компьютер" in text:
                result.setdefault("bk", col)
            if "примеч" in text or "комментар" in text:
                result.setdefault("comment", col)
    return result


def _depot_number(value: str) -> int | None:
    text = _norm(value)
    match = re.search(r"(?:депо\s*)?(?:№|n)?\s*([12])(?:\D|$)", text)
    return int(match.group(1)) if match else None


def _same_depot(current: str, wanted: str) -> bool:
    current_norm = _norm(current)
    wanted_norm = _norm(wanted)
    if not current_norm or not wanted_norm:
        return False
    wanted_number = _depot_number(wanted_norm)
    current_number = _depot_number(current_norm)
    if wanted_number is not None and current_number is not None:
        return wanted_number == current_number and "трол" in current_norm
    return wanted_norm in current_norm or current_norm in wanted_norm


def parse_morning(rows: list[dict[int, Any]], depot_name: str) -> list[Observation]:
    header = _find_header(rows, ("гар", "причина")) or 3
    cols = _header_columns(rows, max(1, header - 1), header + 2)
    depot_col = cols.get("depot", 2)
    route_col = cols.get("route", 3)
    schedule_col = cols.get("schedule", 4)
    board_col = cols.get("board", 5)
    bk_col = cols.get("bk", 10)
    comment_col = cols.get("comment", 13)
    current_depot = ""
    found: dict[int, Observation] = {}
    for row in rows:
        row_no = int(row.get(0, 0))
        if row_no <= header:
            continue
        depot_value = row.get(depot_col)
        if depot_value not in (None, ""):
            current_depot = str(depot_value)
        if not _same_depot(current_depot, depot_name):
            continue
        board = _board(row.get(board_col))
        bk = row.get(bk_col)
        bk_num = _as_number(bk)
        bk_text = _norm(bk)
        is_problem = (bk_num is not None and bk_num > 0) or (
            bk_num is None and bk_text not in {"", "0", "нет", "исправен", "норма"}
        )
        if not board or not is_problem:
            continue
        found[board] = Observation(
            board=board,
            route=str(row.get(route_col) or "").strip(),
            schedule=str(row.get(schedule_col) or "").strip(),
            comment=str(row.get(comment_col) or "").strip(),
            raw_row=row_no,
        )
    return sorted(found.values(), key=lambda item: item.board)


def parse_evening(rows: list[dict[int, Any]], depot_name: str) -> list[Observation]:
    header = _find_header(rows, ("предприят", "гар")) or 3
    cols = _header_columns(rows, header, header + 2)
    depot_col = cols.get("depot", 1)
    route_col = cols.get("route", 2)
    board_col = cols.get("board", 3)
    comment_col = cols.get("comment", 4)
    current_depot = ""
    found: dict[int, Observation] = {}
    for row in rows:
        row_no = int(row.get(0, 0))
        if row_no <= header:
            continue
        depot_value = row.get(depot_col)
        if depot_value not in (None, ""):
            current_depot = str(depot_value)
        if not _same_depot(current_depot, depot_name):
            continue
        board = _board(row.get(board_col))
        if not board:
            continue
        found[board] = Observation(
            board=board,
            route=str(row.get(route_col) or "").strip(),
            comment=str(row.get(comment_col) or "").strip(),
            raw_row=row_no,
        )
    return sorted(found.values(), key=lambda item: item.board)


def detect_period_explicit(text: str) -> str | None:
    normalized = _norm(text)
    if re.search(r"(^|\D)(17|18)[.:_-]?00(\D|$)", normalized) or "вечер" in normalized:
        return "evening"
    if re.search(r"(^|\D)(7|8|9)[.:_-]?00(\D|$)", normalized) or "утро" in normalized:
        return "morning"
    return None


def detect_period(text: str, local_hour: int, cutoff: int = 12) -> str:
    return detect_period_explicit(text) or ("morning" if local_hour < cutoff else "evening")


def infer_auto_periods(
    parsed: ParsedWorkbook,
    *,
    hint_text: str = "",
    fallback_hour: int | None = None,
    workbook_local_hour: int | None = None,
    cutoff: int = 12,
) -> tuple[list[tuple[str, list[Observation]]], str]:
    """Choose which snapshots the workbook contains without trusting only email arrival time.

    Evening workbooks normally retain the morning sheet, so a final/evening file can safely
    backfill both periods. Morning files have an empty evening template; their save time is
    normally around 08:00 and must not be mistaken for an evening report merely because the
    email was delivered later.
    """
    explicit = detect_period_explicit(hint_text)
    if explicit == "morning":
        return [("morning", parsed.morning)], "тип «утро» указан в теме или имени файла"
    if explicit == "evening":
        return [
            ("morning", parsed.morning),
            ("evening", parsed.evening),
        ], "тип «вечер» указан в теме или имени файла"

    if parsed.evening:
        return [
            ("morning", parsed.morning),
            ("evening", parsed.evening),
        ], "в вечернем листе найдены неисправные машины"

    if workbook_local_hour is not None:
        if workbook_local_hour >= cutoff:
            return [
                ("morning", parsed.morning),
                ("evening", parsed.evening),
            ], f"файл сохранён в {workbook_local_hour:02d}:xx — определён как итоговый вечерний"
        return [("morning", parsed.morning)], f"файл сохранён в {workbook_local_hour:02d}:xx — определён как утренний"

    if parsed.morning:
        return [("morning", parsed.morning)], "данные найдены только в утреннем листе"

    hour = fallback_hour if fallback_hour is not None else 8
    if hour >= cutoff:
        return [
            ("morning", parsed.morning),
            ("evening", parsed.evening),
        ], "пустой файл определён как вечерний по времени получения"
    return [("morning", parsed.morning)], "пустой файл определён как утренний по времени получения"


def parse_xlsx(path: str | Path, depot_name: str) -> ParsedWorkbook:
    path = Path(path)
    content = path.read_bytes()
    parsed = ParsedWorkbook(
        filename=path.name,
        sha256=hashlib.sha256(content).hexdigest(),
        workbook_date=None,
    )
    try:
        with zipfile.ZipFile(path) as zf:
            parsed.workbook_modified = _core_modified(zf)
            shared = _parse_shared_strings(zf)
            paths = _sheet_paths(zf)
            sheet_rows: dict[str, list[dict[int, Any]]] = {}
            for name, sheet_path in paths.items():
                try:
                    sheet_rows[name] = _read_sheet(zf, sheet_path, shared)
                except (KeyError, ET.ParseError) as exc:
                    parsed.warnings.append(f"Не удалось прочитать лист «{name}»: {exc}")

            parsed.workbook_date = _date_from_rows(sheet_rows)
            if parsed.workbook_date is not None:
                parsed.workbook_date_source = "workbook-content"
            else:
                parsed.warnings.append(
                    "Дата отчёта не найдена в содержимом XLSX; дата изменения файла не используется."
                )

            morning_name = next(
                (name for name in sheet_rows if "разниц" in _norm(name)),
                None,
            )
            evening_name = next(
                (
                    name
                    for name in sheet_rows
                    if ("неиспр" in _norm(name) or "неисправ" in _norm(name))
                    and ("17" in _norm(name) or "18" in _norm(name))
                ),
                None,
            )
            parsed.morning_sheet_found = morning_name is not None
            parsed.evening_sheet_found = evening_name is not None

            if morning_name:
                parsed.morning = parse_morning(sheet_rows[morning_name], depot_name)
            else:
                parsed.warnings.append("Не найден утренний лист «Разница».")
            if evening_name:
                parsed.evening = parse_evening(sheet_rows[evening_name], depot_name)
            else:
                parsed.warnings.append("Не найден вечерний лист «Неиспр.БК 17-00».")

            if not parsed.morning_sheet_found and not parsed.evening_sheet_found:
                raise ValueError("Структура файла не похожа на поддерживаемый отчёт User metro: не найдены листы утреннего или вечернего отчёта.")
    except zipfile.BadZipFile as exc:
        raise ValueError("Файл не является корректным XLSX.") from exc
    except (KeyError, ET.ParseError) as exc:
        raise ValueError(f"Повреждена внутренняя структура XLSX: {exc}") from exc
    return parsed
