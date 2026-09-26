"""MFapi.in client, used only to backfill each scheme's older NAV history.

MFapi.in is a free, unofficial JSON mirror of AMFI's data with each scheme's full
history in one request, which makes it the practical way to get years of NAVs.
It is not trusted for recent days: the pipeline re-checks recent NAVs against
AMFI's own files, and AMFI wins any disagreement.
"""
from __future__ import annotations

import logging
import time
from datetime import date

import requests

from amfi import HEADERS, parse_date, parse_nav

log = logging.getLogger("mfapi")

URL = "https://api.mfapi.in/mf/{code}"


class MfapiError(Exception):
    pass


def fetch_history(session: requests.Session, code: int, attempts: int = 4,
                  timeout: int = 60) -> list[tuple[date, float]] | None:
    """Full NAV history for one scheme, oldest first. None if MFapi doesn't know the scheme."""
    url = URL.format(code=code)
    last: Exception | None = None
    for i in range(attempts):
        try:
            r = session.get(url, headers=HEADERS, timeout=timeout)
        except requests.RequestException as e:
            last = e
            time.sleep(2 ** (i + 1))
            continue
        if r.status_code == 404:
            return None
        if r.status_code in (429, 500, 502, 503, 504):
            last = MfapiError(f"HTTP {r.status_code}")
            time.sleep(3 * 2 ** i)
            continue
        if r.status_code != 200:
            raise MfapiError(f"{url} answered HTTP {r.status_code}")
        try:
            payload = r.json()
        except ValueError as e:
            raise MfapiError(f"{url} did not return JSON") from e
        rows = payload.get("data") or []
        out = []
        for row in rows:
            d = parse_date(str(row.get("date", "")))
            v = parse_nav(str(row.get("nav", "")))
            if d and v:
                out.append((d, v))
        out.sort()
        return out or None
    raise MfapiError(f"{url} failed after {attempts} tries: {last}")
