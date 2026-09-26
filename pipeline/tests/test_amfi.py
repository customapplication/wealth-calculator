from datetime import date

import pytest
import requests

import amfi
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def test_new_format_uses_plan_and_option_columns():
    schemes, header = amfi.parse_navall((FIXTURES / "navall_new.txt").read_text(encoding="utf-8"))
    assert "Plan" in header and "Option" in header
    by = {s.code: s for s in schemes}
    s = by[135762]
    assert s.name == "Axis Children's Fund"            # HTML entity decoded
    assert s.amc == "Axis Mutual Fund"
    assert s.section == "Open Ended Schemes"
    assert s.category == "Children’s Fund - Childrens' Fund"
    assert (s.plan, s.plan_label, s.option) == ("Direct", "Direct Plan", "Growth")
    assert s.nav == 30.0236 and s.nav_date == date(2026, 9, 23)
    assert s.isin_growth == "INF846K01WO1" and s.isin_reinv is None
    assert by[135765].option == "IDCW"
    assert by[135759].plan == "Regular"
    assert by[999002].nav is None                      # "N.A." is not a number
    assert by[777001].section == "Close Ended Schemes"
    assert by[122639].category == "Equity Scheme - Flexi Cap Fund"


def test_old_format_reads_plan_and_option_from_name():
    schemes, header = amfi.parse_navall((FIXTURES / "navall_old.txt").read_text(encoding="utf-8"))
    assert "Plan" not in header
    by = {s.code: s for s in schemes}
    assert (by[120001].plan, by[120001].option) == ("Direct", "Growth")   # "Dividend Yield" is not IDCW
    assert (by[120002].plan, by[120002].option) == ("Direct", "IDCW")
    assert (by[120003].plan, by[120003].option) == ("Regular", "Growth")
    assert by[120004].option == "Growth"                                  # ETFs have no option in the name
    assert by[120004].category == "Other Scheme - Other ETFs"             # double space collapsed


def test_history_report_filters_codes():
    out = amfi.parse_history((FIXTURES / "history_sample.txt").read_text(), codes={122639, 122640})
    assert out[122639] == {date(2026, 9, 21): 91.50, date(2026, 9, 22): 91.80}
    assert 555555 not in out


def test_missing_columns_raise_a_clear_error():
    with pytest.raises(amfi.AmfiFormatError, match="net asset value|Net Asset Value|nav"):
        amfi.parse_navall("Scheme Code;Scheme Name;Date\n1;X;01-Jan-2026\n")


def test_error_page_is_rejected():
    with pytest.raises(amfi.AmfiFormatError):
        amfi.parse_navall("<html><body>Service unavailable</body></html>")


def test_date_and_nav_parsing():
    assert amfi.parse_date("26-10-2024") == date(2024, 10, 26)
    assert amfi.parse_date("23-Sep-2026") == date(2026, 9, 23)
    assert amfi.parse_nav("1,234.5") == 1234.5
    assert amfi.parse_nav("0") is None and amfi.parse_nav("N.A.") is None


class _Resp:
    def __init__(self, text):
        self.status_code, self.content = 200, text.encode()


class _Session:
    """Refuses connections to the hosts in `down`, serves `text` from the rest."""

    def __init__(self, down, text):
        self.down, self.text, self.urls = down, text, []

    def get(self, url, **kw):
        self.urls.append(url)
        if any(h in url for h in self.down):
            raise requests.ConnectionError(f"Tunnel connection failed: {url}")
        return _Resp(self.text)


def test_navall_falls_back_to_the_portal_host_when_www_is_unreachable(monkeypatch):
    monkeypatch.setattr(amfi.time, "sleep", lambda s: None)
    text = (FIXTURES / "navall_new.txt").read_text(encoding="utf-8")
    session = _Session(down=["www.amfiindia.com"], text=text)
    got, url = amfi.fetch_navall(session)
    assert url == "https://portal.amfiindia.com/spages/NAVAll.txt" and got == text


def test_unreachable_amfi_raises_amfi_error(monkeypatch):
    monkeypatch.setattr(amfi.time, "sleep", lambda s: None)
    session = _Session(down=["amfiindia.com"], text="")
    with pytest.raises(amfi.AmfiError, match="Couldn't download NAVAll.txt"):
        amfi.fetch_navall(session)
    assert len(session.urls) == 8                       # 4 tries on each host
    with pytest.raises(amfi.AmfiError, match="Could not fetch"):
        amfi.fetch_history(session, date(2026, 9, 1), date(2026, 9, 25))


def test_store_round_trip(tmp_path):
    from store import Store, decode, encode
    series = {date(2026, 9, 18): 10.5, date(2026, 9, 21): 10.6, date(2026, 9, 22): 10.55}
    obj = encode(7, series)
    assert obj["t"] == [0, 3, 1]
    assert decode(obj) == series
    st = Store(tmp_path)
    st.save(7, series, full_refresh=date(2026, 9, 22))
    assert Store(tmp_path).load(7) == series            # index rebuilt from disk
