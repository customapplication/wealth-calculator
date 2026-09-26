"""Return and risk measures computed from a scheme's daily NAVs.

Conventions (also shown in the app under "How these numbers are worked out"):

* 1-year return is the plain change in NAV. 3, 5 and 10-year returns are CAGR
  between today's NAV and the NAV on the same calendar date N years ago (or the
  last NAV before it, if that day was a holiday).
* Since-launch CAGR uses 365-day years and is left out for funds launched
  before April 2006, because AMFI's NAV history starts then.
* Rolling 3-year returns are CAGR over every 1,096-day window (3 years plus a
  leap day) ending on each NAV date.
* If the NAV needed for a calculation is more than 10 days from its target date
  (a hole in the data), that figure is left blank rather than guessed.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np

ROLL_DAYS = 1096
ROLL_YEARS = 3
MAX_LOOKUP_GAP = 10
AMFI_DATA_START = date(2006, 4, 1)
MIN_ROLLING_POINTS = 20
FRIDAY = 5  # date.toordinal() % 7 == 5 on Fridays


def years_back(d: date, n: int) -> date:
    try:
        return d.replace(year=d.year - n)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year - n, day=28)


def _idx_on_or_before(ords: np.ndarray, target: int) -> int | None:
    i = int(np.searchsorted(ords, target, side="right")) - 1
    if i < 0 or target - int(ords[i]) > MAX_LOOKUP_GAP:
        return None
    return i


def point_to_point(ords: np.ndarray, navs: np.ndarray, years: int) -> float | None:
    end = date.fromordinal(int(ords[-1]))
    target = years_back(end, years).toordinal()
    if int(ords[0]) > target:
        return None
    i = _idx_on_or_before(ords, target)
    if i is None:
        return None
    ratio = navs[-1] / navs[i]
    return float(ratio - 1.0) if years == 1 else float(ratio ** (1.0 / years) - 1.0)


def rolling_cagr(ords: np.ndarray, navs: np.ndarray, days: int = ROLL_DAYS,
                 years: int = ROLL_YEARS) -> tuple[np.ndarray, np.ndarray]:
    targets = ords - days
    idx = np.searchsorted(ords, targets, side="right") - 1
    idx_c = np.clip(idx, 0, None)
    valid = (targets >= ords[0]) & (idx >= 0) & ((targets - ords[idx_c]) <= MAX_LOOKUP_GAP)
    j = np.nonzero(valid)[0]
    r = (navs[j] / navs[idx_c[j]]) ** (1.0 / years) - 1.0
    return ords[j], r


def max_drawdown(ords: np.ndarray, navs: np.ndarray, years: int = 5) -> float | None:
    if len(navs) < 2:
        return None
    start = years_back(date.fromordinal(int(ords[-1])), years).toordinal()
    s = int(np.searchsorted(ords, start, side="left"))
    seg = navs[s:]
    peak = np.maximum.accumulate(seg)
    return float((seg / peak - 1.0).min())


def volatility(ords: np.ndarray, navs: np.ndarray, years: int = 3) -> float | None:
    target = years_back(date.fromordinal(int(ords[-1])), years).toordinal()
    if int(ords[0]) > target:
        return None
    s = int(np.searchsorted(ords, target, side="left"))
    seg = navs[s:]
    if len(seg) < 60:
        return None
    lr = np.diff(np.log(seg))
    span_years = (int(ords[-1]) - int(ords[s])) / 365.25
    if span_years <= 0:
        return None
    per_year = len(lr) / span_years
    return float(np.std(lr, ddof=1) * math.sqrt(per_year))


def _r(x: float | None, nd: int = 6) -> float | None:
    if x is None or not math.isfinite(x):
        return None
    return round(float(x), nd)


def compute(series: dict[date, float], risk_free: float, full_history: bool
            ) -> tuple[dict, tuple[np.ndarray, np.ndarray]]:
    """Metrics for one scheme, plus its weekly rolling-return samples for the consistency score."""
    days = sorted(series)
    ords = np.fromiter((d.toordinal() for d in days), dtype=np.int64, count=len(days))
    navs = np.fromiter((series[d] for d in days), dtype=np.float64, count=len(days))
    empty = (np.array([], dtype=np.int64), np.array([], dtype=np.float64))
    if len(days) < 2:
        return {"age": 0}, empty

    m: dict = {}
    for key, yrs in (("r1", 1), ("r3", 3), ("r5", 5), ("r10", 10)):
        m[key] = _r(point_to_point(ords, navs, yrs))

    age = int(ords[-1] - ords[0])
    m["age"] = age
    launched_before_data = days[0] <= AMFI_DATA_START + timedelta(days=30)
    if full_history and not launched_before_data:
        m["inc"] = days[0].isoformat()
        m["si"] = _r((navs[-1] / navs[0]) ** (365.0 / age) - 1.0) if age >= 365 else None
    else:
        m["inc"] = None
        m["si"] = None
        if launched_before_data:
            m["pre2006"] = True
        if not full_history:
            m["partial"] = True

    ro, rv = rolling_cagr(ords, navs)
    if len(rv) >= MIN_ROLLING_POINTS:
        m["rr3med"] = _r(float(np.median(rv)))
        m["rr3min"] = _r(float(rv.min()))
        m["rr3n"] = int(len(rv))
    else:
        m["rr3med"] = m["rr3min"] = None
        m["rr3n"] = int(len(rv))

    m["mdd5"] = _r(max_drawdown(ords, navs))
    vol = volatility(ords, navs)
    m["vol3"] = _r(vol)
    m["sh3"] = _r((m["r3"] - risk_free) / vol, 3) if (vol and m["r3"] is not None and vol > 1e-9) else None

    weekly = (ro % 7) == FRIDAY
    return m, (ro[weekly], rv[weekly])


def consistency(group: dict[int, tuple[np.ndarray, np.ndarray]], min_funds: int = 3,
                min_weeks: int = 26) -> dict[int, float]:
    """Share of weekly 3-year windows in which each fund beat its peer group's median."""
    codes = [c for c, (o, _) in group.items() if len(o)]
    if len(codes) < min_funds:
        return {}
    all_days = np.unique(np.concatenate([group[c][0] for c in codes]))
    pos = {int(d): i for i, d in enumerate(all_days)}
    mat = np.full((len(codes), len(all_days)), np.nan)
    for row, c in enumerate(codes):
        o, v = group[c]
        mat[row, [pos[int(d)] for d in o]] = v
    counts = np.sum(~np.isnan(mat), axis=0)
    usable = counts >= min_funds
    med = np.full(len(all_days), np.nan)
    if usable.any():
        med[usable] = np.nanmedian(mat[:, usable], axis=0)
    out: dict[int, float] = {}
    for row, c in enumerate(codes):
        mask = usable & ~np.isnan(mat[row])
        if mask.sum() >= min_weeks:
            out[c] = round(float(np.mean(mat[row, mask] > med[mask])), 4)
    return out
