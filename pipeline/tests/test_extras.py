"""Launch dates from AMFI's scheme master, the typical fund per category, default
benchmarks and the nightly link check."""
import json
from datetime import date

import pytest
import requests

import amfi
import build
import links
import schemedata
import test_build
from test_build import NAV_DATE, TODAY, FakeNet, cfg

# The layout of AMFI's scheme data CSV, header spacing and all; rows are illustrative.
SCHEME_CSV = """﻿AMC,Code,Scheme Name,Scheme Type,Scheme Category,Scheme NAV Name,Scheme Minimum Amount,Launch Date, Closure Date,ISIN Div Payout/ ISIN GrowthISIN Div Reinvestment
Test Mutual Fund,101,Alpha Flexi Cap Fund,Open Ended,Equity Scheme - Flexi Cap Fund,Alpha Flexi Cap Fund - Direct Plan - Growth,500,01-JAN-2013,,INF000000101
Test Mutual Fund,201,Alpha Flexi Cap Fund,Open Ended,Equity Scheme - Flexi Cap Fund,Alpha Flexi Cap Fund - Regular Plan - Growth,500,17-Oct-2007,,INF000000201
Test Mutual Fund,102,Beta Flexi Cap Fund,Open Ended,Equity Scheme - Flexi Cap Fund,"Beta Flexi Cap Fund - Direct Plan, Growth",500,02-01-2013,,INF000000102
Test Mutual Fund,103,Gamma Flexi Cap Fund,Open Ended,Equity Scheme - Flexi Cap Fund,Gamma Flexi Cap Fund - Direct Plan - Growth,500,,,INF000000103
Test Mutual Fund,105,Delta Liquid Fund,Open Ended,Debt Scheme - Liquid Fund,Delta Liquid Fund - Regular Plan - Growth,500,not a date,,INF000000105
"""


def test_scheme_data_is_read_by_header_name():
    m = schemedata.parse(SCHEME_CSV)
    assert m[101] == {"l": "2013-01-01", "s": "Alpha Flexi Cap Fund", "a": "Test Mutual Fund"}
    assert m[102]["l"] == "2013-01-02", "a quoted name with a comma doesn't shift the columns"
    assert "l" not in m[103] and "l" not in m[105], "a blank or unreadable date is left out"
    first = schemedata.launches(m)
    assert first[101] == ("2013-01-01", "2007-10-17"), "the scheme itself launched with its Regular plan"
    assert first[201] == ("2007-10-17", None)
    assert first[103] == (None, None)


def test_scheme_data_needs_its_columns():
    with pytest.raises(amfi.AmfiFormatError, match="launch"):
        schemedata.parse("AMC,Code,Scheme Name\nX,1,Y\n")


def test_scheme_data_falls_back_to_the_last_good_copy(tmp_path):
    class Good:
        def scheme_data(self):
            return SCHEME_CSV

    class Bad:
        def scheme_data(self):
            raise amfi.AmfiError("portal.amfiindia.com returned a web page instead of data")

    m, st = schemedata.load(Good(), tmp_path, TODAY)
    assert st["ok"] and st["with_launch_date"] == 3 and m[101]["l"] == "2013-01-01"
    m, st = schemedata.load(Bad(), tmp_path, TODAY)
    assert st["ok"] is False and "web page" in st["error"]
    assert st["using_copy_from"] == TODAY.isoformat() and m[101]["l"] == "2013-01-01"
    m, st = schemedata.load(Bad(), tmp_path / "empty", TODAY)
    assert m == {} and st["ok"] is False


@pytest.mark.parametrize("answer,ok", [
    (200, True), (301, True), (403, None), (429, None), (503, None), (404, False), (410, False),
    ("ConnectionError: [Errno -2] Name or service not known", False),
    ("ConnectionError: [Errno 111] Connection refused", False),
    ("ReadTimeout: read timed out", None),
])
def test_link_verdicts(answer, ok):
    assert links.verdict(answer) is ok


def test_every_fund_house_in_a_statement_finds_its_site():
    find = links.matcher(links.load()["amcs"])
    # names as a CAS or AMFI writes them, old ones included
    for name, host in [("HDFC Mutual Fund", "hdfcfund"), ("BOI AXA Mutual Fund", "boimf"), ("Bank of India Mutual Fund", "boimf"),
                       ("Kotak Mahindra Mutual Fund", "kotakmf"), ("Kotak Mutual Fund", "kotakmf"), ("PPFAS Mutual Fund", "ppfas"),
                       ("Nippon India Mutual Fund", "nipponindiaim"), ("quant Mutual Fund", "quantmutual"),
                       ("Quantum Mutual Fund", "quantumamc"), ("Mirae Asset Mutual Fund", "miraeassetmf"),
                       ("Aditya Birla Sun Life Mutual Fund", "adityabirla"), ("IDFC Mutual Fund", "bandhan"),
                       ("Mahindra Manulife Mutual Fund", "mahindramanulife"), ("L&T Mutual Fund", "hsbc")]:
        a = find(name)
        assert a and host in a["url"], name
    assert find("Some New Mutual Fund") is None


INDEX_FUND = ("Omega Nifty 500 Index Fund", "Other Scheme - Index Funds", "Direct Plan", "Growth Option", 0.11,
              date(2019, 9, 2))
NEXT50_FUND = ("Omega Nifty Next 50 Index Fund", "Other Scheme - Index Funds", "Direct Plan", "Growth Option", 0.13,
               date(2014, 1, 6))


class ExtrasNet(FakeNet):
    LINKS = {"portals": [{"id": "p", "name": "Portal", "url": "https://portal.example/"}],
             "amcs": [{"name": "Gone Mutual Fund", "match": "gone", "url": "https://gone.example/"},
                      {"name": "Shy Mutual Fund", "match": "shy", "url": "https://shy.example/"},
                      {"name": "Moved Mutual Fund", "match": "moved", "url": "https://moved.example/"}]}

    def scheme_data(self):
        return SCHEME_CSV

    def link_status(self, url):
        if "moved" in url:
            raise requests.ConnectionError("[Errno -2] Name or service not known")
        return {"https://gone.example/": 404, "https://shy.example/": 403}.get(url, 200)


def test_a_build_writes_launch_dates_the_typical_fund_benchmarks_and_links(tmp_path, monkeypatch):
    monkeypatch.setitem(test_build.FUNDS, 106, INDEX_FUND)
    monkeypatch.setitem(test_build.FUNDS, 107, NEXT50_FUND)
    out = tmp_path / "site"
    out.mkdir()
    meta = build.run(cfg(verify_days=45, links=ExtrasNet.LINKS), tmp_path / "cache", out, ExtrasNet(), today=TODAY)
    data = json.loads((out / "funds.json").read_text())
    funds = {f["c"]: f for f in data["funds"]}
    assert funds[101]["l"] == "2013-01-01" and funds[101]["L"] == "2007-10-17"
    assert funds[102]["l"] == "2013-01-02" and "L" not in funds[102]
    assert "l" not in funds[103], "no date in AMFI's file, none in ours"
    assert meta["scheme_data"]["ok"] is True

    # the typical Direct flexi cap fund: three funds, chained weekly medians
    key = "Equity Scheme - Flexi Cap Fund|Direct"
    assert data["cats"][key]["n"] == 3 and data["cats"][key]["f"] == "equity-scheme-flexi-cap-fund-direct"
    from store import decode
    typical = decode(json.loads((out / "cat" / "equity-scheme-flexi-cap-fund-direct.json").read_text()))
    days = sorted(typical)
    assert all(d.weekday() == 4 for d in days) and typical[days[0]] == 100
    assert days[-1] <= NAV_DATE and days[0].year == 2015, "starts once three funds have NAVs"
    cagr = (typical[days[-1]] / 100) ** (365 / (days[-1] - days[0]).days) - 1
    assert 0.09 < cagr < 0.16, "between the slowest and fastest fund"
    assert "Debt Scheme - Liquid Fund|Regular" not in data["cats"], "one fund isn't a category median"

    # flexi cap's benchmark is the Nifty 500 index fund, not the Nifty Next 50 one
    assert data["bench"]["Equity Scheme - Flexi Cap Fund"] == {"i": "Nifty 500", "c": 106, "n": INDEX_FUND[0]}
    assert "Debt Scheme - Liquid Fund" not in data["bench"]

    site_links = json.loads((out / "links.json").read_text())
    ok = {a["name"]: a["ok"] for a in site_links["amcs"]}
    assert ok == {"Gone Mutual Fund": False, "Shy Mutual Fund": None, "Moved Mutual Fund": False}
    assert site_links["portals"][0]["ok"] is True
    assert {b["name"] for b in meta["links"]["broken"]} == {"Gone Mutual Fund", "Moved Mutual Fund"}
    assert meta["links"]["no_link"] == ["Test Mutual Fund"]


def test_extras_never_stop_the_build(tmp_path):
    class Broken(FakeNet):
        def scheme_data(self):
            raise amfi.AmfiError("down")

        def link_status(self, url):
            raise RuntimeError("no network")

    out = tmp_path / "site"
    out.mkdir()
    meta = build.run(cfg(verify_days=45), tmp_path / "cache", out, Broken(), today=TODAY)
    assert meta["scheme_data"]["ok"] is False
    assert (out / "funds.json").exists() and (out / "links.json").exists()
    assert all(a["ok"] is None for a in json.loads((out / "links.json").read_text())["amcs"])
