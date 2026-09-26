"""Copies of AMFI's data in the owner's Google Drive, through their archive
Apps Script (sheets/Archive.gs).

Every night the NAVAll.txt that was downloaded goes up gzipped, named by the
day it was downloaded (IST):

    Corpus planner archive/NAVAll/2026/09/NAVAll-2026-09-26.txt.gz

Once a month, and whenever Drive has no copy yet, the tracked funds' full NAV
history (.cache/nav/*.json and .cache/index.json) goes up as a few .tar.gz
parts, so the history survives even if GitHub's cache is emptied and MFapi.in
is gone. Restore it with:  for f in *.tar.gz; do tar xzf "$f" -C .cache; done

Nothing here can stop the build. The workflow passes ARCHIVE_URL and
ARCHIVE_SECRET from the repository's Actions secrets; without them the archive
is skipped and meta.json says so.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import html
import io
import json
import logging
import os
import re
import tarfile
import time
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import requests

log = logging.getLogger("archive")

APP = "corpus-planner-archive"


class ArchiveError(Exception):
    def __init__(self, msg: str, final: bool = False):
        super().__init__(msg)
        self.final = final          # the script answered and said no: retrying won't help


class Archive:
    """Talks to the archive Apps Script. `session` is swappable for tests."""

    def __init__(self, url: str, secret: str, session=None, attempts: int = 3, timeout: int = 300):
        self.url, self.secret = url, secret
        self.session = session or requests.Session()
        self.attempts, self.timeout = attempts, timeout

    @classmethod
    def from_env(cls) -> "Archive | None":
        url, secret = os.environ.get("ARCHIVE_URL", "").strip(), os.environ.get("ARCHIVE_SECRET", "").strip()
        return cls(url, secret) if url and secret else None

    def call(self, action: str, **body) -> dict:
        payload = json.dumps({"secret": self.secret, "action": action, **body})
        last: Exception | None = None
        for i in range(self.attempts):
            try:
                # Apps Script answers a POST with a redirect to the result, which
                # requests follows as a GET, the way a browser does.
                r = self.session.post(self.url, data=payload.encode("utf-8"), timeout=self.timeout,
                                      headers={"Content-Type": "text/plain;charset=utf-8"})
                if r.status_code >= 500 or r.status_code == 429:
                    raise ArchiveError(f"the archive script answered HTTP {r.status_code}")
                try:
                    j = r.json()
                except ValueError:
                    msg, final = web_page(r)
                    raise ArchiveError(msg, final=final) from None
                if not isinstance(j, dict) or j.get("app") != APP:
                    raise ArchiveError("ARCHIVE_URL points at a different Apps Script; deploy sheets/Archive.gs "
                                       "and use its URL", final=True)
                if not j.get("ok"):
                    raise ArchiveError(j.get("error") or "the archive script turned the request down", final=True)
                return j
            except ArchiveError as e:
                if e.final:
                    raise
                last = e
            except requests.RequestException as e:
                last = ArchiveError(f"couldn't reach the archive script: {e}")
            if i < self.attempts - 1:
                time.sleep(5 * (i + 1))
        raise last or ArchiveError("the archive script couldn't be reached")

    def put_daily(self, day: date, raw: bytes) -> dict:
        """Store one day's NAVAll.txt. Re-sending the same file the same day stores nothing new."""
        gz = gzip.compress(raw, compresslevel=9, mtime=0)
        return self.call("putDaily", date=day.isoformat(), md5=hashlib.md5(raw).hexdigest(), size=len(raw),
                         data=base64.b64encode(gz).decode("ascii"))

    def put_snapshot(self, cache_dir: Path, snap_id: str, part_bytes: int, info: dict) -> dict:
        """Send the NAV history as .tar.gz parts, then ask the script to swap it in as the latest copy."""
        parts = history_parts(Path(cache_dir), part_bytes)
        if not parts:
            raise ArchiveError("there's no NAV history to back up yet")
        sums = []
        for n, (blob, count) in enumerate(parts, 1):
            sha = hashlib.sha256(blob).hexdigest()
            self.call("snapshotPut", id=snap_id, part=n, parts=len(parts), sha256=sha,
                      data=base64.b64encode(blob).decode("ascii"))
            sums.append({"part": n, "files": count, "bytes": len(blob), "sha256": sha})
        manifest = {**info, "id": snap_id, "parts": sums,
                    "restore": 'for f in *.tar.gz; do tar xzf "$f" -C .cache; done'}
        return self.call("snapshotCommit", id=snap_id, parts=len(parts), manifest=manifest)


def web_page(r) -> tuple[str, bool]:
    """Say what went wrong when Google answered with a web page instead of the script's data.

    Returns (message, final). The page's title, and where Google redirected
    to, usually name the cause; neither contains the secret, which is only in
    the request body.
    """
    text = getattr(r, "text", "") or ""
    host = urlparse(getattr(r, "url", "") or "").netloc
    m = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    title = re.sub(r"\s+", " ", html.unescape(m.group(1))).strip()[:80] if m else ""
    seen = f"Google answered with a web page ({title or 'untitled'}, HTTP {getattr(r, 'status_code', '?')})"
    if "accounts.google.com" in host or re.search(r"sign.?in", title, re.I):
        return (f"{seen}: it asked for a sign-in. In the archive's Apps Script, open Deploy -> Manage deployments -> "
                "Edit and set Who has access to Anyone (not 'Anyone with a Google account'), and check that ARCHIVE_URL "
                "is the web app URL ending in /exec, not /dev or the editor's address", True)
    if re.search(r"function not found", text, re.I):
        return (f"{seen}: the deployed version doesn't contain Archive.gs. Save the code, then Deploy -> Manage "
                "deployments -> Edit -> Version: New version -> Deploy", True)
    if re.search(r"authori[sz]ation is required|needs your permission|authori[sz]e", text, re.I):
        return (f"{seen}: the script isn't authorised yet. In the Apps Script editor choose doGet, press Run, "
                "and allow the permissions it asks for", True)
    if "script.google.com" in host and re.search(r"/(edit|home)\b", urlparse(getattr(r, "url", "")).path):
        return (f"{seen}: ARCHIVE_URL is the editor's address. Use the web app URL from Deploy -> Manage "
                "deployments, which ends in /exec", True)
    return (f"{seen}. Check that the deployment's Who has access is Anyone and that ARCHIVE_URL is the web app URL "
            "ending in /exec. Opening that URL in a private browser window should show "
            '{"ok":true,"app":"corpus-planner-archive",...}', False)


def history_parts(cache_dir: Path, part_bytes: int) -> list[tuple[bytes, int]]:
    """The history files as .tar.gz archives of roughly part_bytes each: [(archive, files in it)]."""
    files = []
    if (cache_dir / "index.json").exists():
        files.append((cache_dir / "index.json", "index.json"))
    files += [(p, f"nav/{p.name}") for p in sorted((cache_dir / "nav").glob("*.json"), key=lambda p: p.name)]
    parts: list[tuple[bytes, int]] = []
    buf = tar = None
    count = 0

    def close():
        nonlocal buf, tar, count
        if tar is not None:
            tar.close()
            parts.append((buf.getvalue(), count))
        buf = tar = None
        count = 0

    for path, arcname in files:
        if tar is None:
            buf = io.BytesIO()
            tar = tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9)
        data = path.read_bytes()
        ti = tarfile.TarInfo(arcname)
        ti.size, ti.mtime, ti.mode = len(data), 0, 0o644
        tar.addfile(ti, io.BytesIO(data))
        count += 1
        if buf.tell() >= part_bytes:       # compressed bytes written so far
            close()
    close()
    return parts


def archive_daily(archive: "Archive | None", raw: bytes, day: date) -> dict:
    """Store the day's NAVAll.txt, right after download, so even a build that stops keeps its copy.
    Returns a status for meta.json, with the latest history snapshot's id when Drive reported one."""
    if archive is None:
        return {"configured": False}
    try:
        res = archive.put_daily(day, raw)
        log.info("Archive: NAVAll.txt %s as %s", "stored" if res.get("stored") else "already there", res.get("name"))
        return {"configured": True, "ok": True, "daily": {"name": res.get("name"), "stored": bool(res.get("stored"))},
                "latest_snapshot": (res.get("snapshot") or {}).get("id")}
    except Exception as e:  # noqa: BLE001 - the archive must never stop the build
        log.warning("Archive: couldn't store today's NAVAll.txt: %s", e)
        return {"configured": True, "ok": False, "daily": {"error": str(e)[:300]}}


def archive_history(archive: "Archive | None", status: dict, day: date, cache_dir: Path, cfg: dict,
                    info: dict) -> dict:
    """Send the NAV history when a month has passed since the last copy, or there's none. Never raises."""
    if archive is None or not status.get("configured"):
        return status
    status = dict(status)
    if "error" in status.get("daily", {}):
        status["snapshot"] = {"skipped": "the archive didn't answer earlier in this run"}
        return status
    last = status.pop("latest_snapshot", None)
    if last and (day - date.fromisoformat(last)).days < cfg["archive_snapshot_every_days"]:
        status["snapshot"] = {"latest": last, "due": False}
        return status
    try:
        res = archive.put_snapshot(cache_dir, day.isoformat(), cfg["archive_part_bytes"], info)
        status["snapshot"] = {"latest": day.isoformat(), "stored": True, "parts": res.get("parts")}
        log.info("Archive: NAV history snapshot %s stored in %s parts", day, res.get("parts"))
    except Exception as e:  # noqa: BLE001
        log.warning("Archive: couldn't store the NAV history: %s", e)
        status.update(ok=False, snapshot={"latest": last, "error": str(e)[:300]})
    return status
