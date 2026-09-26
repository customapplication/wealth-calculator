from datetime import date, timedelta

import numpy as np
import pytest

import metrics


def business_days(start, end):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def steady(rate, start=date(2014, 1, 1), end=date(2026, 9, 25), base=10.0):
    return {d: base * (1 + rate) ** ((d - start).days / 365.0) for d in business_days(start, end)}


def test_steady_growth_gives_that_rate_everywhere():
    m, _ = metrics.compute(steady(0.12), 0.065, full_history=True)
    for k in ("r1", "r3", "r5", "r10", "si", "rr3med", "rr3min"):
        assert m[k] == pytest.approx(0.12, abs=2e-3), k
    assert m["mdd5"] == pytest.approx(0.0, abs=1e-9)
    assert m["vol3"] < 0.01
    assert m["inc"] == "2014-01-01"


def test_young_fund_has_no_long_returns():
    s = steady(0.10, start=date(2025, 1, 1))
    m, _ = metrics.compute(s, 0.065, full_history=True)
    assert m["r1"] is not None and m["r3"] is None and m["r5"] is None and m["rr3med"] is None


def test_pre_2006_fund_gets_no_since_launch_figure():
    s = steady(0.15, start=date(2006, 4, 3))
    m, _ = metrics.compute(s, 0.065, full_history=True)
    assert m["si"] is None and m["inc"] is None and m.get("pre2006")


def test_partial_history_gets_no_since_launch_figure():
    m, _ = metrics.compute(steady(0.1), 0.065, full_history=False)
    assert m["si"] is None and m.get("partial")


def test_drawdown():
    s = steady(0.0, start=date(2024, 1, 1))
    days = sorted(s)
    for i, d in enumerate(days):
        if i >= 100:
            s[d] = 7.0 if i < 200 else 12.0   # falls 30%, then recovers
    m, _ = metrics.compute(s, 0.065, full_history=True)
    assert m["mdd5"] == pytest.approx(-0.30, abs=1e-9)


def test_hole_in_data_blanks_the_figure_instead_of_guessing():
    s = steady(0.12)
    end = max(s)
    three_back = metrics.years_back(end, 3)
    for d in list(s):
        if three_back - timedelta(days=40) <= d <= three_back + timedelta(days=5):
            del s[d]
    m, _ = metrics.compute(s, 0.065, full_history=True)
    assert m["r3"] is None and m["r5"] is not None


def test_consistency_ranks_the_steadier_winner_first():
    groups = {}
    for code, rate in ((1, 0.14), (2, 0.12), (3, 0.10), (4, 0.08)):
        _, wk = metrics.compute(steady(rate), 0.065, True)
        groups[code] = wk
    c = metrics.consistency(groups)
    assert c[1] == 1.0 and c[4] == 0.0
    assert set(c) == {1, 2, 3, 4}
