"""On-disk NAV history store.

Each scheme lives in nav/<code>.json in a compact form that the website reads
as-is:

    {"c": 122639, "s": "2013-05-24", "t": [0, 3, 1, 1, ...], "v": [10.0, 10.01, ...]}

`s` is the first date. `t` holds the gap in days from the previous NAV date
(0 for the first), which keeps files small because most gaps are 1 or 3.
`v` is the NAV on that day, exactly as published.
index.json keeps each scheme's first/last date and when it last had a full
history download, so a nightly run doesn't need to open every file to plan.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path


def encode(code: int, series: dict[date, float]) -> dict:
    days = sorted(series)
    ords = [d.toordinal() for d in days]
    return {
        "c": code,
        "s": days[0].isoformat(),
        "t": [0] + [b - a for a, b in zip(ords, ords[1:])],
        "v": [series[d] for d in days],
    }


def decode(obj: dict) -> dict[date, float]:
    o = date.fromisoformat(obj["s"]).toordinal()
    out = {}
    for gap, v in zip(obj["t"], obj["v"]):
        o += gap
        out[date.fromordinal(o)] = float(v)
    return out


def dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.nav_dir = self.root / "nav"
        self.nav_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "index.json"
        self.index: dict[str, dict] = {}
        if self.index_path.exists():
            try:
                self.index = json.loads(self.index_path.read_text())
            except ValueError:
                self.index = {}
        if not self.index:
            self._rebuild_index()

    def _rebuild_index(self) -> None:
        for p in self.nav_dir.glob("*.json"):
            try:
                obj = json.loads(p.read_text())
                series = decode(obj)
            except (ValueError, KeyError):
                continue
            if series:
                days = sorted(series)
                self.index[str(obj["c"])] = {"f": days[0].isoformat(), "l": days[-1].isoformat(), "n": len(days)}

    def path(self, code: int) -> Path:
        return self.nav_dir / f"{code}.json"

    def entry(self, code: int) -> dict | None:
        return self.index.get(str(code))

    def last_date(self, code: int) -> date | None:
        e = self.entry(code)
        return date.fromisoformat(e["l"]) if e else None

    def load(self, code: int) -> dict[date, float] | None:
        p = self.path(code)
        if not p.exists():
            return None
        try:
            return decode(json.loads(p.read_text()))
        except (ValueError, KeyError):
            return None

    def save(self, code: int, series: dict[date, float], full_refresh: date | None = None) -> None:
        if not series:
            return
        self.path(code).write_text(dumps(encode(code, series)))
        days = sorted(series)
        prev = self.index.get(str(code), {})
        e = {"f": days[0].isoformat(), "l": days[-1].isoformat(), "n": len(days)}
        if full_refresh:
            e["r"] = full_refresh.isoformat()
        elif prev.get("r"):
            e["r"] = prev["r"]
        self.index[str(code)] = e

    def save_index(self) -> None:
        self.index_path.write_text(dumps(self.index))
