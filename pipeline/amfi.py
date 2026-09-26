"""Fetch and parse AMFI's public NAV files.

AMFI (Association of Mutual Funds in India) publishes two files this project uses:

* NAVAll.txt: the latest NAV of every scheme, refreshed each business day.
* DownloadNAVHistoryReport_Po.aspx: NAVs of every scheme for a date range.

Both are semicolon-separated text with section lines ("Open Ended Schemes(Equity
Scheme - Large Cap Fund)") and fund-house lines mixed in between the data rows.

Columns are located by their header names, never by position. On 19-Aug-2026
AMFI inserted Plan and Option columns before the NAV, which broke parsers that
counted fields; this one reads the header and carries on. The history report
changed too: the first live run (26-Sep-2026) got
    Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date
where it used to have Scheme Name, and Repurchase Price and Sale Price are gone.
Each parser asks only for the columns it uses.
"""
from __future__ import annotations

import html
import logging
import math
import re
import time
from dataclasses import dataclass
from datetime import date, datetime

import requests

log = logging.getLogger("amfi")

NAVALL_URLS = (
    "https://www.amfiindia.com/spages/NAVAll.txt",
    "https://portal.amfiindia.com/spages/NAVAll.txt",
)
HISTORY_URL = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0 Safari/537.36 mf-corpus-planner"
    ),
    "Accept": "text/plain,text/html;q=0.9,*/*;q=0.8",
}

SECTION_RE = re.compile(r"^(?P<section>[^()]*?Schemes?)\s*\((?P<category>.+)\)\s*$", re.I)
IDCW_RE = re.compile(r"idcw|dividend|\bdiv\b|payout|reinvest|bonus|income distribution", re.I)
DIRECT_RE = re.compile(r"\bdirect\b|\bdir\b", re.I)
DATE_FORMATS = ("%d-%b-%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%B-%Y")
NAVALL_NEEDS = frozenset({"code", "name", "nav", "date"})
HISTORY_NEEDS = frozenset({"code", "nav", "date"})     # its name column is only for people


class AmfiError(Exception):
    """AMFI could not be reached or answered with something other than data."""


class AmfiFormatError(AmfiError):
    """AMFI's file no longer has the columns this parser needs."""


@dataclass
class Scheme:
    code: int
    name: str
    amc: str
    section: str            # e.g. "Open Ended Schemes"
    category: str           # e.g. "Equity Scheme - Large Cap Fund"
    plan: str               # "Direct" or "Regular" (any non-direct plan)
    plan_label: str         # AMFI's own wording, e.g. "Direct Plan"; "" in the old format
    option: str             # "Growth", "IDCW" or "Other"
    isin_growth: str | None
    isin_reinv: str | None
    nav: float | None
    nav_date: date | None


# --------------------------------------------------------------------------- helpers

def parse_date(s: str) -> date | None:
    s = (s or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def parse_nav(s: str) -> float | None:
    s = (s or "").replace(",", "").strip()
    try:
        v = float(s)
    except ValueError:
        return None
    return v if v > 0 and math.isfinite(v) else None


def _norm(h: str) -> str:
    h = html.unescape(h).strip().lstrip("\ufeff").lower()
    h = re.sub(r"\s*/\s*", "/", h)
    return re.sub(r"\s+", " ", h)


def _column_map(header: list[str], needs=NAVALL_NEEDS) -> dict[str, int]:
    idx: dict[str, int] = {}
    for i, raw in enumerate(header):
        h = _norm(raw)
        if h == "scheme code":
            idx["code"] = i
        elif h in ("scheme name", "nav name"):
            idx["name"] = i
        elif h.startswith("isin div payout"):
            idx["isin_growth"] = i
        elif h.startswith("isin div reinvest"):
            idx["isin_reinv"] = i
        elif h == "plan":
            idx["plan"] = i
        elif h == "option":
            idx["option"] = i
        elif h == "net asset value":
            idx["nav"] = i
        elif h == "date":
            idx["date"] = i
    missing = set(needs) - idx.keys()
    if missing:
        raise AmfiFormatError(
            f"AMFI's header no longer has these columns: {sorted(missing)}. Header was: {header}"
        )
    return idx


def normalise_plan(plan_field: str, name: str) -> str:
    text = plan_field or name
    return "Direct" if DIRECT_RE.search(text) else "Regular"


def normalise_option(option_field: str, name: str) -> str:
    if option_field:
        if re.search(r"growth", option_field, re.I):
            return "Growth"
        if IDCW_RE.search(option_field):
            return "IDCW"
        return "Other"
    # Old format: the option is only in the scheme name. "Growth" wins so that
    # a "Dividend Yield Fund - Growth" isn't mistaken for an IDCW option.
    if re.search(r"growth", name, re.I):
        return "Growth"
    if IDCW_RE.search(name):
        return "IDCW"
    return "Growth"


def _isin(s: str) -> str | None:
    s = (s or "").strip()
    return s if len(s) == 12 and s[:2].isalpha() else None


def _scan(text: str, needs=NAVALL_NEEDS):
    """Yield ('header', fields, colmap) once, then ('row', fields, context) for each data row."""
    colmap = None
    section = category = amc = ""
    for raw in text.splitlines():
        # Unescape before splitting: an entity such as &#x27; contains a semicolon.
        line = html.unescape(raw).strip().lstrip("\ufeff")
        if not line:
            continue
        if colmap is None:
            if _norm(line).startswith("scheme code;"):
                header = [f.strip() for f in line.split(";")]
                colmap = _column_map(header, needs)
                yield "header", header, colmap
            continue
        if ";" in line:
            fields = [f.strip() for f in line.split(";")]
            if len(fields) <= max(colmap.values()) or not fields[colmap["code"]].isdigit():
                continue  # repeated header, footer or malformed row
            yield "row", fields, (section, category, amc)
        else:
            m = SECTION_RE.match(line)
            if m:
                section = re.sub(r"\s+", " ", m.group("section")).strip()
                category = re.sub(r"\s+", " ", html.unescape(m.group("category"))).strip()
                amc = ""
            else:
                amc = html.unescape(line)
    if colmap is None:
        raise AmfiFormatError("No 'Scheme Code' header found; AMFI may have returned an error page.")


def _decode(content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("cp1252", errors="replace")


# --------------------------------------------------------------------------- parsing

def parse_navall(text: str) -> tuple[list[Scheme], list[str]]:
    """Parse NAVAll.txt into schemes. Returns (schemes, header)."""
    schemes: list[Scheme] = []
    header: list[str] = []
    cm: dict[str, int] = {}
    seen: set[int] = set()
    for kind, a, b in _scan(text, NAVALL_NEEDS):
        if kind == "header":
            header, cm = a, b
            continue
        fields, (section, category, amc) = a, b
        code = int(fields[cm["code"]])
        if code in seen:
            continue
        seen.add(code)
        name = re.sub(r"\s+", " ", html.unescape(fields[cm["name"]])).strip()
        plan_raw = fields[cm["plan"]] if "plan" in cm else ""
        opt_raw = fields[cm["option"]] if "option" in cm else ""
        schemes.append(Scheme(
            code=code,
            name=name,
            amc=amc,
            section=section,
            category=category,
            plan=normalise_plan(plan_raw, name),
            plan_label=plan_raw,
            option=normalise_option(opt_raw, name),
            isin_growth=_isin(fields[cm["isin_growth"]]) if "isin_growth" in cm else None,
            isin_reinv=_isin(fields[cm["isin_reinv"]]) if "isin_reinv" in cm else None,
            nav=parse_nav(fields[cm["nav"]]),
            nav_date=parse_date(fields[cm["date"]]),
        ))
    return schemes, header


def parse_history(text: str, codes: set[int] | None = None) -> dict[int, dict[date, float]]:
    """Parse AMFI's NAV history report into {scheme code: {date: nav}}."""
    out: dict[int, dict[date, float]] = {}
    cm: dict[str, int] = {}
    for kind, a, b in _scan(text, HISTORY_NEEDS):
        if kind == "header":
            cm = b
            continue
        code = int(a[cm["code"]])
        if codes is not None and code not in codes:
            continue
        d, v = parse_date(a[cm["date"]]), parse_nav(a[cm["nav"]])
        if d and v:
            out.setdefault(code, {})[d] = v
    return out


# --------------------------------------------------------------------------- fetching

def _get(session: requests.Session, url: str, params: dict | None = None,
         timeout: int = 180, attempts: int = 4) -> str:
    last: Exception | None = None
    for i in range(attempts):
        try:
            r = session.get(url, params=params, headers=HEADERS, timeout=timeout)
            if r.status_code == 200:
                text = _decode(r.content)
                if text.lstrip()[:1] == "<":
                    raise AmfiError(f"{url} returned a web page instead of data")
                return text
            last = AmfiError(f"{url} answered HTTP {r.status_code}")
        except (requests.RequestException, AmfiError) as e:
            last = e
        if i < attempts - 1:
            time.sleep(2 ** (i + 1))
    # Always an AmfiError, so fetch_navall falls back to the other host on a
    # connection failure too, and build.main reports it instead of crashing.
    if isinstance(last, AmfiError):
        raise last
    raise AmfiError(f"Could not fetch {url}: {last}") from last


def fetch_navall(session: requests.Session) -> tuple[str, str]:
    """Download NAVAll.txt, trying AMFI's two hosts. Returns (text, url used)."""
    errors = []
    for url in NAVALL_URLS:
        try:
            text = _get(session, url)
            if "scheme code" not in text[:600].lower():
                raise AmfiFormatError(f"{url} did not start with the expected header")
            return text, url
        except AmfiError as e:
            log.warning("NAVAll from %s failed: %s", url, e)
            errors.append(str(e))
    raise AmfiError("Couldn't download NAVAll.txt from AMFI: " + " | ".join(errors))


def fetch_history(session: requests.Session, frm: date, to: date, tp: int = 1) -> str:
    """Download AMFI's NAV history report for a date range (tp=1: open-ended schemes)."""
    params = {"tp": tp, "frmdt": frm.strftime("%d-%b-%Y"), "todt": to.strftime("%d-%b-%Y")}
    return _get(session, HISTORY_URL, params=params, timeout=300)
