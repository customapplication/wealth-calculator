"""Turn your CAMS + KFintech Consolidated Account Statement (CAS) into a file the
Corpus planner's "My portfolio" page can import.

    pip install -r tools/requirements.txt
    python tools/cas_to_json.py statement.pdf --out my-portfolio.json
    (you'll be asked for the PDF password; it isn't stored anywhere)

Run this on your own computer. The output keeps only what the portfolio page
needs: each scheme's AMFI code, ISIN, name, fund house, the last 4 digits of the
folio, and every transaction (date, type, amount, units, NAV). Your name, PAN,
email, phone and address are dropped. Even so, treat the file as private and
never commit it to the repository.

Use a *Detailed* CAS covering the full period since your first investment. A
Summary CAS only has closing balances, so the page couldn't show your history.
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

FORMAT = "mf-corpus-planner/cas-v1"


def _num(x):
    if x is None or x == "":
        return None
    try:
        return float(Decimal(str(x)))
    except Exception:  # noqa: BLE001
        return None


def _date(x) -> str | None:
    if isinstance(x, (date, datetime)):
        return x.strftime("%Y-%m-%d")
    s = str(x or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _mask(folio: str) -> str:
    digits = "".join(ch for ch in str(folio or "") if ch.isalnum())
    return ("••••" + digits[-4:]) if digits else ""


def convert(cas: dict) -> dict:
    """Convert casparser's JSON output into the portfolio import format."""
    cas_type = str(cas.get("cas_type", "")).upper()
    if cas_type == "SUMMARY":
        raise ValueError(
            "This is a Summary CAS, which has closing balances but no transactions. "
            "Request a Detailed CAS for the full period instead."
        )
    period = cas.get("statement_period") or {}
    holdings, warnings = [], list(cas.get("parse_warnings") or [])
    for folio in cas.get("folios") or []:
        for sch in folio.get("schemes") or []:
            txns = []
            for t in sch.get("transactions") or []:
                d = _date(t.get("date"))
                if not d:
                    warnings.append(f"Skipped a transaction with no readable date in {sch.get('scheme')}")
                    continue
                txns.append({
                    "date": d,
                    "type": str(t.get("type") or "UNKNOWN"),
                    "amount": _num(t.get("amount")),
                    "units": _num(t.get("units")),
                    "nav": _num(t.get("nav")),
                    "desc": str(t.get("description") or "")[:80],
                })
            txns.sort(key=lambda t: t["date"])
            val = sch.get("valuation") or {}
            amfi = sch.get("amfi")
            holdings.append({
                "amfi": int(amfi) if str(amfi or "").isdigit() else None,
                "isin": sch.get("isin"),
                "name": sch.get("scheme"),
                "amc": folio.get("amc"),
                "folio": _mask(folio.get("folio")),
                "rta": sch.get("rta"),
                "open_units": _num(sch.get("open")),
                "close_units": _num(sch.get("close")),
                "valuation": {"date": _date(val.get("date")), "nav": _num(val.get("nav")), "value": _num(val.get("value"))},
                "txns": txns,
            })
            if not sch.get("amfi") and not sch.get("isin"):
                warnings.append(f"No AMFI code or ISIN for {sch.get('scheme')}; the page may not find its NAVs")
            if (_num(sch.get("open")) or 0) > 0.0005:
                warnings.append(
                    f"{sch.get('scheme')} already held {_num(sch.get('open'))} units when this statement starts. "
                    "Use a statement that begins before your first investment for complete figures."
                )
    return {
        "format": FORMAT,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "statement_period": {"from": _date(period.get("from") or period.get("from_")), "to": _date(period.get("to"))},
        "file_type": cas.get("file_type"),
        "cas_type": cas_type,
        "holdings": holdings,
        "warnings": warnings,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path, help="Your CAS PDF from CAMS, KFintech or MF Central")
    ap.add_argument("--out", type=Path, default=Path("my-portfolio.json"))
    ap.add_argument("--password", help="PDF password. Leave out to be asked without it showing on screen.")
    args = ap.parse_args(argv)

    try:
        import casparser
    except ImportError:
        print("casparser isn't installed. Run: pip install -r tools/requirements.txt", file=sys.stderr)
        return 1
    password = args.password or getpass.getpass("CAS PDF password: ")
    try:
        raw = casparser.read_cas_pdf(str(args.pdf), password, output="json")
    except Exception as e:  # noqa: BLE001
        print(f"Couldn't read {args.pdf}: {e}", file=sys.stderr)
        return 1
    try:
        result = convert(json.loads(raw))
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1

    args.out.write_text(json.dumps(result, indent=1, ensure_ascii=False))
    n_tx = sum(len(h["txns"]) for h in result["holdings"])
    print(f"Wrote {args.out}: {len(result['holdings'])} schemes, {n_tx} transactions.")
    for w in result["warnings"]:
        print("  note:", w)
    print("Import it on the My portfolio page. Keep the file private and out of git.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
