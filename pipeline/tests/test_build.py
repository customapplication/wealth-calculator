"""End-to-end build against a fake network: stale MFapi, AMFI filling the gap and winning disagreements."""
import json
import math
from datetime import date, timedelta

import build

TODAY = date(2026, 9, 26)          # a Saturday
NAV_DATE = date(2026, 9, 25)
MFAPI_STOPS = date(2026, 8, 18)     # MFapi went stale after AMFI's format change

FUNDS = {
    # code: (name, category, plan, option, yearly rate, launch)
    101: ("Alpha Flexi Cap Fund", "Equity Scheme - Flexi Cap Fund", "Direct Plan", "Growth Option", 0.16, date(2013, 1, 2)),
    102: ("Beta Flexi Cap Fund", "Equity Scheme - Flexi Cap Fund", "Direct Plan", "Growth Option", 0.12, date(2013, 1, 2)),
    103: ("Gamma Flexi Cap Fund", "Equity Scheme - Flexi Cap Fund", "Direct Plan", "Growth Option", 0.09, date(2015, 6, 1)),
    104: ("Gamma Flexi Cap Fund", "Equity Scheme - Flexi Cap Fund", "Direct Plan", "IDCW Option", 0.09, date(2015, 6, 1)),
    105: ("Delta Liquid Fund", "Debt Scheme - Liquid Fund", "Regular Plan", "Growth Option", 0.065, date(2010, 1, 4)),
}


def true_nav(code, d):
    rate, launch = FUNDS[code][4], FUNDS[code][5]
    t = (d - launch).days / 365.0
    return round(10 * (1 + rate) ** t * (1 + 0.03 * math.sin(t * 6 + code)), 4)


def bdays(a, b):
    d = a
    while d <= b:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


class FakeNet:
    def __init__(self):
        self.mfapi_calls = []
        self.history_calls = []

    def navall(self):
        lines = ["Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date", ""]
        cats = {}
        for code, f in FUNDS.items():
            cats.setdefault(f[1], []).append(code)
        for cat, codes in cats.items():
            lines += [f"Open Ended Schemes({cat})", "", "Test Mutual Fund", ""]
            for code in codes:
                n, _, plan, opt, *_ = FUNDS[code]
                lines.append(f"{code};INF00000{code:04d};-;{n};{plan};{opt};{true_nav(code, NAV_DATE)};{NAV_DATE:%d-%b-%Y}")
        return "\n".join(lines), "https://www.amfiindia.com/spages/NAVAll.txt"

    def history(self, frm, to, tp):
        self.history_calls.append((frm, to))
        lines = ["Scheme Code;Scheme Name;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Repurchase Price;Sale Price;Date",
                 "", "Open Ended Schemes ( Equity Scheme - Flexi Cap Fund )", "", "Test Mutual Fund", ""]
        for code in FUNDS:
            for d in bdays(max(frm, FUNDS[code][5]), min(to, NAV_DATE)):
                lines.append(f"{code};{FUNDS[code][0]};INF;;{true_nav(code, d)};;;{d:%d-%b-%Y}")
        return "\n".join(lines)

    def mfapi(self, code):
        self.mfapi_calls.append(code)
        rows = [(d, true_nav(code, d)) for d in bdays(FUNDS[code][5], MFAPI_STOPS)]
        # one wrong value inside the window AMFI re-checks
        if code == 101:
            rows = [(d, v + 1.0 if d == MFAPI_STOPS else v) for d, v in rows]
        return rows


def cfg(**over):
    c = dict(build.DEFAULT_CONFIG)
    c.update(over)
    return c


def test_first_run_backfills_fills_gap_and_corrects(tmp_path):
    net = FakeNet()
    out = tmp_path / "site"
    out.mkdir()
    meta = build.run(cfg(verify_days=45), tmp_path / "cache", out, net, today=TODAY)

    tracked = {101, 102, 103, 105}                     # 104 is IDCW
    assert sorted(net.mfapi_calls) == sorted(tracked)
    assert net.history_calls and net.history_calls[0][0] <= MFAPI_STOPS + timedelta(days=1)
    assert meta["counts"]["tracked"] == 4 and meta["counts"]["active"] == 5
    assert meta["amfi_history"]["ok"]
    assert meta["amfi_history"]["points_corrected"] == 1
    assert meta["corrections"][0]["code"] == 101
    assert meta["recent_gaps"]["count"] == 0          # the Aug-Sep gap was filled from AMFI

    funds = {f["c"]: f for f in json.loads((out / "funds.json").read_text())["funds"]}
    assert funds[104]["h"] == 0 and funds[104]["m"] is None
    m = funds[101]["m"]
    assert m["r5"] is not None and m["inc"] == "2013-01-02" and m["cons"] == 1.0
    assert funds[103]["m"]["cons"] == 0.0

    from store import decode
    nav = json.loads((out / "nav" / "101.json").read_text())
    days = decode(nav)
    assert max(days) == NAV_DATE and nav["v"][-1] == true_nav(101, NAV_DATE)
    assert days[MFAPI_STOPS] == true_nav(101, MFAPI_STOPS)       # AMFI's value replaced MFapi's
    assert days[date(2026, 9, 1)] == true_nav(101, date(2026, 9, 1))


def test_second_run_is_incremental(tmp_path):
    out = tmp_path / "site"
    out.mkdir()
    build.run(cfg(verify_days=45), tmp_path / "cache", out, FakeNet(), today=TODAY)
    net = FakeNet()
    meta = build.run(cfg(mfapi_refresh_cycle_days=10_000), tmp_path / "cache", out, net, today=TODAY)
    assert net.mfapi_calls == []
    assert meta["amfi_history"]["points_corrected"] == 0
    assert meta["amfi_history"]["points_checked"] > 0


def test_stale_amfi_file_stops_the_build(tmp_path):
    import pytest
    with pytest.raises(build.BuildError, match="days ago"):
        build.run(cfg(), tmp_path / "cache", tmp_path, FakeNet(), today=TODAY + timedelta(days=30))


def test_amfi_history_failure_is_reported_not_fatal(tmp_path):
    net = FakeNet()
    def boom(*a):
        raise RuntimeError("AMFI portal timed out")
    net.history = boom
    out = tmp_path / "site"
    out.mkdir()
    meta = build.run(cfg(), tmp_path / "cache", out, net, today=TODAY)
    assert meta["amfi_history"]["ok"] is False
    assert "timed out" in meta["amfi_history"]["errors"][0]
    assert meta["recent_gaps"]["count"] == 4          # MFapi stopped in August and nothing filled it
