"""AMFI's scheme master: when each scheme and each of its plans was launched.

AMFI publishes one CSV of every scheme it knows, with a launch date per scheme
code (each plan and option has its own code):

    AMC,Code,Scheme Name,Scheme Type,Scheme Category,Scheme NAV Name,
    Scheme Minimum Amount,Launch Date, Closure Date,ISIN Div Payout/ ISIN Growth...

Columns are found by header name, as for NAVAll.txt, and a date that doesn't
parse is left out rather than guessed. The file isn't needed to publish: if it
can't be fetched or read, the build keeps the last good copy it has (with its
date) or goes without launch dates.
"""
from __future__ import annotations

import csv
import io
import json
import logging
from datetime import date
from pathlib import Path

import amfi

log = logging.getLogger("schemedata")

URL = "https://portal.amfiindia.com/DownloadSchemeData_Po.aspx"
PARAMS = {"mf": 0}
NEEDS = frozenset({"code", "launch"})


def _column_map(header: list[str]) -> dict[str, int]:
    idx: dict[str, int] = {}
    for i, raw in enumerate(header):
        h = amfi._norm(raw)
        if h in ("code", "scheme code"):
            idx["code"] = i
        elif h == "launch date":
            idx["launch"] = i
        elif h == "scheme name":
            idx["scheme"] = i
        elif h == "amc":
            idx["amc"] = i
        elif h == "closure date":
            idx["closure"] = i
    missing = NEEDS - idx.keys()
    if missing:
        raise amfi.AmfiFormatError(f"AMFI's scheme data has no {sorted(missing)} column. Header was: {header}")
    return idx


def parse(text: str) -> dict[int, dict]:
    """{code: {"l": launch ISO date, "s": scheme name, "a": AMC}} for every row with a readable code."""
    rows = csv.reader(io.StringIO(text.lstrip("﻿")))
    idx = None
    out: dict[int, dict] = {}
    for row in rows:
        if not row or not any(c.strip() for c in row):
            continue
        if idx is None:
            idx = _column_map(row)
            continue
        try:
            code = int(row[idx["code"]].strip())
        except (ValueError, IndexError):
            continue
        rec: dict = {}
        d = amfi.parse_date(row[idx["launch"]]) if idx["launch"] < len(row) else None
        if d and date(1960, 1, 1) <= d <= date.today():
            rec["l"] = d.isoformat()
        for key, col in (("s", "scheme"), ("a", "amc")):
            if col in idx and idx[col] < len(row) and row[idx[col]].strip():
                rec[key] = " ".join(row[idx[col]].split())
        out[code] = rec
    if idx is None:
        raise amfi.AmfiFormatError("AMFI's scheme data was empty")
    return out


def launches(master: dict[int, dict]) -> dict[int, tuple[str | None, str | None]]:
    """{code: (this plan's launch, the scheme's first launch across its plans, if earlier)}."""
    first: dict[tuple, str] = {}
    for rec in master.values():
        if rec.get("l") and rec.get("s"):
            key = (rec.get("a"), rec["s"])
            first[key] = min(first.get(key, rec["l"]), rec["l"])
    out = {}
    for code, rec in master.items():
        own = rec.get("l")
        scheme = first.get((rec.get("a"), rec.get("s"))) if rec.get("s") else None
        out[code] = (own, scheme if scheme and own and scheme < own else None)
    return out


def load(net, cache_dir: Path, today: date) -> tuple[dict[int, dict], dict]:
    """Fetch and parse the scheme data, falling back to the last good copy. Never raises."""
    path = Path(cache_dir) / "scheme_data.json"
    try:
        master = parse(net.scheme_data())
        with_dates = sum(1 for r in master.values() if r.get("l"))
        if not with_dates:
            raise amfi.AmfiFormatError("AMFI's scheme data had no readable launch dates")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"fetched": today.isoformat(), "schemes": master}))
        log.info("Scheme data: %d schemes, %d with a launch date", len(master), with_dates)
        return master, {"ok": True, "schemes": len(master), "with_launch_date": with_dates, "fetched": today.isoformat()}
    except Exception as e:  # noqa: BLE001 - launch dates are optional
        log.warning("Scheme data: %s", e)
        status = {"ok": False, "error": str(e)[:300]}
        if path.exists():
            try:
                saved = json.loads(path.read_text())
                master = {int(k): v for k, v in saved["schemes"].items()}
                status.update(using_copy_from=saved.get("fetched"), schemes=len(master))
                return master, status
            except Exception as e2:  # noqa: BLE001
                status["copy_error"] = str(e2)[:200]
        return {}, status
