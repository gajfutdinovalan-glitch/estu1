from __future__ import annotations

import argparse
import base64
import json
import sys
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parser import infer_auto_periods, parse_xlsx


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("path")
    cli.add_argument("--depot", default="Троллейбусное Депо №2")
    cli.add_argument("--hint", default="")
    cli.add_argument("--fallback-hour", type=int, default=8)
    cli.add_argument("--cutoff", type=int, default=12)
    cli.add_argument("--mode", choices=("auto", "morning", "evening", "both"), default="auto")
    cli.add_argument("--base64", action="store_true")
    args = cli.parse_args()

    parsed = parse_xlsx(Path(args.path), args.depot)
    modified_hour = None
    if parsed.workbook_modified is not None:
        try:
            modified_hour = parsed.workbook_modified.astimezone(ZoneInfo("Europe/Moscow")).hour
        except Exception:
            modified_hour = (parsed.workbook_modified + timedelta(hours=3)).hour

    if args.mode == "morning":
        periods = [("morning", parsed.morning)]
        reason = "тип отчёта выбран вручную: утро"
    elif args.mode == "evening":
        periods = [("evening", parsed.evening)]
        reason = "тип отчёта выбран вручную: вечер"
    elif args.mode == "both":
        periods = [("morning", parsed.morning), ("evening", parsed.evening)]
        reason = "импорт обоих периодов выбран вручную"
    else:
        periods, reason = infer_auto_periods(
            parsed,
            hint_text=args.hint,
            fallback_hour=args.fallback_hour,
            workbook_local_hour=modified_hour,
            cutoff=args.cutoff,
        )

    payload = {
        "filename": parsed.filename,
        "sha256": parsed.sha256,
        "workbookDate": parsed.workbook_date.isoformat() if parsed.workbook_date else None,
        "workbookDateSource": parsed.workbook_date_source,
        "workbookModified": parsed.workbook_modified.isoformat() if parsed.workbook_modified else None,
        "warnings": parsed.warnings,
        "detectionReason": reason,
        "periods": [
            {"period": period, "observations": [asdict(item) for item in observations]}
            for period, observations in periods
        ],
    }
    output = json.dumps(payload, ensure_ascii=False)
    print(base64.b64encode(output.encode("utf-8")).decode("ascii") if args.base64 else output)


if __name__ == "__main__":
    main()
