"""The official websites the app links to, checked every night.

pipeline/links.json is the hand-kept list: MF Central, CAMS and KFintech, and
each fund house's own site. The build asks each address whether it still
exists and writes site/data/links.json with the answer. A site that is gone
(not found, or its name no longer resolves) is marked ok: false and the app
hides it; a site that turns robots away or times out stays listed, as
ok: null. meta.json names both, plus any fund house AMFI lists that has no
entry, so the list can be kept up to date. Nothing here can stop the build.
"""
from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

log = logging.getLogger("links")

DEFAULT_FILE = Path(__file__).resolve().parent / "links.json"
GONE_STATUS = {404, 410}
GONE_ERRORS = re.compile(r"name or service not known|nodename nor servname|getaddrinfo|name resolution|"
                         r"no address associated|connection refused|certificate verify failed", re.I)


def load(path: Path | None = None) -> dict:
    data = json.loads(Path(path or DEFAULT_FILE).read_text())
    return {"portals": data.get("portals", []), "amcs": data.get("amcs", [])}


def verdict(status) -> bool | None:
    """True: the site answered. False: it's gone. None: couldn't tell (robots blocked, timeout, server trouble)."""
    if isinstance(status, int):
        if status < 400:
            return True
        return False if status in GONE_STATUS else None
    return False if GONE_ERRORS.search(str(status)) else None


def matcher(amcs: list[dict]):
    pats = [(re.compile(a["match"], re.I), a) for a in amcs]
    return lambda name: next((a for p, a in pats if p.search(name or "")), None)


def check(net, data: dict, amc_names: list[str], today: date, workers: int = 8) -> tuple[dict, dict]:
    """(site/data/links.json, meta status). Never raises."""
    try:
        entries = data["portals"] + data["amcs"]
        answers: dict[str, object] = {}
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(net.link_status, e["url"]): e["url"] for e in entries}
            for f in as_completed(futs):
                try:
                    answers[futs[f]] = f.result()
                except Exception as e:  # noqa: BLE001
                    answers[futs[f]] = f"{type(e).__name__}: {e}"
        out = {"checked": today.isoformat(), "portals": [], "amcs": []}
        broken, unsure = [], []
        for key in ("portals", "amcs"):
            for e in data[key]:
                ok = verdict(answers.get(e["url"]))
                out[key].append({**e, "ok": ok})
                if ok is False:
                    broken.append({"name": e["name"], "url": e["url"], "answer": str(answers.get(e["url"]))[:120]})
                elif ok is None:
                    unsure.append({"name": e["name"], "url": e["url"], "answer": str(answers.get(e["url"]))[:120]})
        find = matcher(data["amcs"])
        missing = sorted({n for n in amc_names if n and not find(n)})
        status = {"ok": True, "checked": len(entries), "broken": broken, "unsure": unsure, "no_link": missing}
        if broken:
            log.warning("Links: %d no longer exist: %s", len(broken), [b["url"] for b in broken])
        if missing:
            log.info("Links: fund houses with no website listed: %s", missing)
        log.info("Links: %d checked, %d gone, %d couldn't be checked", len(entries), len(broken), len(unsure))
        return out, status
    except Exception as e:  # noqa: BLE001 - links are optional
        log.warning("Links: check failed: %s", e)
        return {"checked": None, "portals": data.get("portals", []), "amcs": data.get("amcs", [])}, {"ok": False, "error": str(e)[:300]}
