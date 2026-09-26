"""Nightly mutual fund data build.

    python pipeline/build.py                     # uses pipeline/config.json, .cache and site/data
    python pipeline/build.py --out /tmp/data     # write the site data somewhere else

What one run does:

1. Downloads AMFI's NAVAll.txt (the official latest NAV of every scheme) and
   stops if it's missing, malformed or more than a week old.
2. Picks the schemes to track (open-ended, Growth option, Direct and Regular
   plans by default, plus any scheme codes in extra_schemes).
3. Backfills full history from MFapi.in for schemes that don't have it yet,
   and refreshes a small rotating slice each night to fill any holes.
4. Downloads AMFI's own NAV history report for the last few days, plus any gap
   since a scheme was last updated, and overwrites whatever the cache held for
   those days. AMFI wins every disagreement, and each correction is recorded.
5. Adds tonight's NAV from NAVAll.txt, computes returns and risk measures, and
   writes site/data/funds.json, site/data/meta.json and site/data/nav/<code>.json.
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import amfi  # noqa: E402
import metrics  # noqa: E402
import mfapi  # noqa: E402
from store import Store, dumps, encode  # noqa: E402

log = logging.getLogger("build")
IST = timezone(timedelta(hours=5, minutes=30))
ROOT = Path(__file__).resolve().parent.parent

DEFAULT_CONFIG = {
    "sections": ["Open Ended Schemes"],
    "plans": ["Direct", "Regular"],
    "options": ["Growth"],
    "extra_schemes": [],
    "exclude_name_patterns": ["segregated"],
    "stale_after_days": 14,
    "max_navall_age_days": 7,
    "risk_free_rate": 0.065,
    "verify_days": 7,
    "amfi_gap_fill_max_days": 180,
    "amfi_history_chunk_days": 30,
    "amfi_history_tp": 1,
    "mfapi_workers": 6,
    "mfapi_max_per_run": 5000,
    "mfapi_refresh_cycle_days": 30,
}


class BuildError(Exception):
    pass


class Net:
    """Network access, one requests.Session per thread. Tests swap this for a fake."""

    def __init__(self) -> None:
        self._local = threading.local()

    def _session(self) -> requests.Session:
        s = getattr(self._local, "s", None)
        if s is None:
            s = self._local.s = requests.Session()
        return s

    def navall(self) -> tuple[str, str]:
        return amfi.fetch_navall(self._session())

    def history(self, frm: date, to: date, tp: int) -> str:
        return amfi.fetch_history(self._session(), frm, to, tp)

    def mfapi(self, code: int):
        time.sleep(0.05)  # be polite to a free service
        return mfapi.fetch_history(self._session(), code)


def load_config(path: Path | None) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if path and path.exists():
        user = json.loads(path.read_text())
        cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
    cfg["extra_schemes"] = [int(c) for c in cfg.get("extra_schemes", [])]
    return cfg


def same_nav(a: float, b: float) -> bool:
    return abs(a - b) <= 5e-7 * max(1.0, abs(b))


def select_schemes(schemes: list[amfi.Scheme], cfg: dict, max_date: date):
    patterns = [p.lower() for p in cfg["exclude_name_patterns"]]
    sections = [s.lower() for s in cfg["sections"]]
    extra = set(cfg["extra_schemes"])
    active = [
        s for s in schemes
        if s.nav is not None and s.nav_date is not None
        and any(s.section.lower().startswith(x) for x in sections)
        and (max_date - s.nav_date).days <= cfg["stale_after_days"]
        and not any(p in s.name.lower() for p in patterns)
    ]
    targets = [
        s for s in active
        if (s.plan in cfg["plans"] and s.option in cfg["options"]) or s.code in extra
    ]
    # extra_schemes may point at schemes outside the configured sections (e.g. an interval fund)
    have = {s.code for s in targets}
    for s in schemes:
        if s.code in extra and s.code not in have and s.nav is not None and s.nav_date:
            targets.append(s)
            active.append(s)
    return active, targets


def plan_backfill(targets, store: Store, cfg: dict, today: date) -> tuple[list[int], int]:
    missing, lagging, rotate = [], [], []
    for s in targets:
        e = store.entry(s.code)
        if not e or not e.get("r"):
            missing.append(s.code)
            continue
        last = date.fromisoformat(e["l"])
        if (s.nav_date - last).days > cfg["amfi_gap_fill_max_days"]:
            lagging.append(s.code)
        elif (today.toordinal() + s.code) % cfg["mfapi_refresh_cycle_days"] == 0:
            rotate.append(s.code)
    order = missing + lagging + rotate
    return order[: cfg["mfapi_max_per_run"]], len(order)


def backfill(codes: list[int], store: Store, net, cfg: dict, today: date) -> dict:
    fetched, failed, last_dates = 0, [], Counter()
    if not codes:
        return {"requested": 0, "fetched": 0, "failed": [], "latest_date_seen": None}
    log.info("MFapi backfill for %d schemes", len(codes))
    with ThreadPoolExecutor(max_workers=cfg["mfapi_workers"]) as pool:
        futures = {pool.submit(net.mfapi, c): c for c in codes}
        for n, fut in enumerate(as_completed(futures), 1):
            code = futures[fut]
            try:
                rows = fut.result()
            except Exception as e:  # noqa: BLE001 - one bad scheme mustn't stop the run
                failed.append({"code": code, "error": str(e)[:160]})
                continue
            if not rows:
                failed.append({"code": code, "error": "no history returned"})
                continue
            series = store.load(code) or {}
            for d, v in rows:
                series.setdefault(d, v)  # fill only: never overwrite AMFI-sourced days
            store.save(code, series, full_refresh=today)
            last_dates[rows[-1][0]] += 1
            fetched += 1
            if n % 250 == 0:
                log.info("  %d/%d done", n, len(codes))
                store.save_index()
    store.save_index()
    latest = max(last_dates, key=lambda d: (last_dates[d], d)) if last_dates else None
    return {
        "requested": len(codes),
        "fetched": fetched,
        "failed_count": len(failed),
        "failed": failed[:25],
        "latest_date_seen": latest.isoformat() if latest else None,
    }


def fetch_amfi_window(net, frm: date, to: date, codes: set[int], cfg: dict):
    out: dict[int, dict[date, float]] = {}
    errors, rows = [], 0
    d = frm
    while d <= to:
        e = min(to, d + timedelta(days=cfg["amfi_history_chunk_days"] - 1))
        try:
            part = amfi.parse_history(net.history(d, e, cfg["amfi_history_tp"]), codes)
            for code, s in part.items():
                out.setdefault(code, {}).update(s)
                rows += len(s)
        except Exception as ex:  # noqa: BLE001
            log.warning("AMFI history %s..%s failed: %s", d, e, ex)
            errors.append(f"{d.isoformat()} to {e.isoformat()}: {str(ex)[:200]}")
        d = e + timedelta(days=1)
    # A report that parses but holds none of our schemes means the check didn't
    # happen; say so instead of reporting a clean check of nothing.
    weekdays = any((frm + timedelta(days=k)).weekday() < 5 for k in range((to - frm).days + 1))
    if not rows and not errors and codes and weekdays:
        msg = f"AMFI's history report for {frm.isoformat()} to {to.isoformat()} had no NAVs for the tracked schemes"
        log.warning("%s", msg)
        errors.append(msg)
    status = {"ok": not errors, "from": frm.isoformat(), "to": to.isoformat(), "rows": rows, "errors": errors}
    return out, status


def recent_gap(series: dict[date, float], end: date, days: int = 60) -> int:
    recent = sorted(d for d in series if d >= end - timedelta(days=days))
    return max((b - a).days for a, b in zip(recent, recent[1:])) if len(recent) > 1 else 0


def run(cfg: dict, cache_dir: Path, out_dir: Path, net, today: date | None = None) -> dict:
    started = time.time()
    today = today or datetime.now(IST).date()

    text, src_url = net.navall()
    schemes, header = amfi.parse_navall(text)
    dated = [s.nav_date for s in schemes if s.nav_date]
    if not dated:
        raise BuildError("AMFI's NAVAll.txt had no dated NAVs")
    # The first live run (Saturday 26-Sep-2026) found NAVs dated the next day.
    # They're kept as AMFI published them, but the build's own date never runs
    # ahead of the day it ran.
    ahead = [s for s in schemes if s.nav_date and s.nav_date > today]
    if ahead:
        log.warning("NAVAll: %d schemes have a NAV dated after today (%s), e.g. %s", len(ahead), today,
                    [(s.code, s.nav_date.isoformat()) for s in ahead[:5]])
    current = [d for d in dated if d <= today]
    if not current:
        raise BuildError(f"Every NAV in AMFI's NAVAll.txt is dated after today ({today}); not publishing.")
    max_date = max(current)
    age = (today - max_date).days
    if age > cfg["max_navall_age_days"]:
        raise BuildError(
            f"AMFI's newest NAV is for {max_date}, {age} days ago. Not publishing stale data; "
            "the previous build stays online."
        )
    log.info("NAVAll: %d schemes, NAVs up to %s, columns %s", len(schemes), max_date, header)

    active, targets = select_schemes(schemes, cfg, max_date)
    if not targets:
        raise BuildError("No schemes matched the configured sections, plans and options")
    log.info("Active open-ended schemes: %d; tracking history for %d", len(active), len(targets))

    store = Store(cache_dir)

    # 1. Backfill older history from MFapi
    todo, pending_total = plan_backfill(targets, store, cfg, today)
    mf_status = backfill(todo, store, net, cfg, today)
    mf_status["pending"] = max(0, pending_total - len(todo))

    # 2. Official AMFI history for recent days and any gaps
    window_from = max_date - timedelta(days=cfg["verify_days"])
    for s in targets:
        last = store.last_date(s.code)
        if last and last < s.nav_date and (s.nav_date - last).days <= cfg["amfi_gap_fill_max_days"]:
            window_from = min(window_from, last + timedelta(days=1))
    codes = {s.code for s in targets}
    hist, hist_status = fetch_amfi_window(net, window_from, max_date, codes, cfg)

    # 3. Merge, verify, compute
    nav_out = out_dir / "nav"
    if nav_out.exists():
        shutil.rmtree(nav_out)
    nav_out.mkdir(parents=True)

    checked = corrected_n = navall_checked = navall_corrected = 0
    corrections: list[dict] = []
    gaps: list[dict] = []
    weekly: dict[tuple[str, str], dict[int, tuple]] = defaultdict(dict)
    per_scheme: dict[int, dict] = {}
    full_count = gap_count = 0

    for n, s in enumerate(targets, 1):
        series = store.load(s.code) or {}
        for d, v in hist.get(s.code, {}).items():
            old = series.get(d)
            if old is not None:
                checked += 1
                if not same_nav(old, v):
                    corrected_n += 1
                    if len(corrections) < 25:
                        corrections.append({"code": s.code, "date": d.isoformat(), "was": old, "amfi": v})
            series[d] = v
        old = series.get(s.nav_date)
        if old is not None:
            navall_checked += 1
            if not same_nav(old, s.nav):
                navall_corrected += 1
                if len(corrections) < 25:
                    corrections.append({"code": s.code, "date": s.nav_date.isoformat(), "was": old, "amfi": s.nav})
        series[s.nav_date] = s.nav
        store.save(s.code, series)

        entry = store.entry(s.code) or {}
        full = bool(entry.get("r"))
        full_count += full
        m, wk = metrics.compute(series, cfg["risk_free_rate"], full)
        per_scheme[s.code] = m
        weekly[(s.category, s.plan)][s.code] = wk

        g = recent_gap(series, s.nav_date)
        if g > 5:
            gap_count += 1
            if len(gaps) < 25:
                gaps.append({"code": s.code, "largest_gap_days": g})
        (nav_out / f"{s.code}.json").write_text(dumps(encode(s.code, series)))
        if n % 1000 == 0:
            log.info("  processed %d/%d", n, len(targets))
    store.save_index()

    for group in weekly.values():
        for code, share in metrics.consistency(group).items():
            per_scheme[code]["cons"] = share

    tracked = {s.code for s in targets}
    funds = []
    for s in active:
        funds.append({
            "c": s.code, "n": s.name, "a": s.amc,
            "g": s.category.partition(" - ")[0].strip(), "k": s.category,
            "p": s.plan, "pl": s.plan_label, "o": s.option,
            "i": s.isin_growth, "i2": s.isin_reinv,
            "v": s.nav, "d": s.nav_date.isoformat(),
            "h": 1 if s.code in tracked else 0,
            "m": per_scheme.get(s.code),
        })
    (out_dir / "funds.json").write_text(dumps({"nav_date": max_date.isoformat(), "funds": funds}))

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "build_seconds": round(time.time() - started, 1),
        "nav_date": max_date.isoformat(),
        "sources": {
            "latest": src_url,
            "history": amfi.HISTORY_URL,
            "backfill": "https://api.mfapi.in",
        },
        "navall_columns": header,
        "navall_ahead": {
            "count": len(ahead),
            "examples": [{"code": s.code, "name": s.name, "date": s.nav_date.isoformat()} for s in ahead[:10]],
        },
        "counts": {
            "schemes_in_file": len(schemes),
            "active": len(active),
            "tracked": len(targets),
            "with_full_history": full_count,
        },
        "amfi_history": {**hist_status, "points_checked": checked, "points_corrected": corrected_n},
        "navall_check": {"points_checked": navall_checked, "points_corrected": navall_corrected},
        "corrections": corrections,
        "mfapi": mf_status,
        "recent_gaps": {"count": gap_count, "examples": gaps},
        "method": {
            "rolling_window_days": metrics.ROLL_DAYS,
            "max_lookup_gap_days": metrics.MAX_LOOKUP_GAP,
            "risk_free_rate": cfg["risk_free_rate"],
            "amfi_data_start": metrics.AMFI_DATA_START.isoformat(),
        },
        "config": {k: cfg[k] for k in ("sections", "plans", "options", "extra_schemes")},
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    log.info("Done in %.0fs: %d funds listed, %d with history", time.time() - started, len(funds), len(targets))
    return meta


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=ROOT / "pipeline" / "config.json")
    ap.add_argument("--cache", type=Path, default=ROOT / ".cache")
    ap.add_argument("--out", type=Path, default=ROOT / "site" / "data")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args.out.mkdir(parents=True, exist_ok=True)
    try:
        run(load_config(args.config), args.cache, args.out, Net())
    except (BuildError, amfi.AmfiError) as e:
        log.error("%s", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
