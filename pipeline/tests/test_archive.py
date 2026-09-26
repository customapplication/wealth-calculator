"""The Google Drive archive: the client, the history parts, and how a build uses it."""
import base64
import gzip
import hashlib
import io
import json
import tarfile
from datetime import date

import pytest
import requests

import archive
import build
from test_build import FUNDS, NAV_DATE, TODAY, FakeNet, cfg


class Resp:
    def __init__(self, status, payload, text="", url="https://script.googleusercontent.com/macros/echo"):
        self.status_code, self._payload, self.text, self.url = status, payload, text, url

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeSession:
    """Answers like Archive.gs: records every request, replies from a queue or a handler."""

    def __init__(self, replies=None, handler=None):
        self.replies, self.handler, self.bodies = list(replies or []), handler, []

    def post(self, url, data, timeout, headers):
        body = json.loads(data)
        self.bodies.append(body)
        if self.handler:
            return self.handler(body)
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def ok(**kw):
    return Resp(200, {"ok": True, "app": archive.APP, **kw})


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(archive.time, "sleep", lambda s: None)


def test_daily_upload_sends_the_exact_file_gzipped():
    s = FakeSession([ok(stored=True, name="NAVAll-2026-09-26.txt.gz")])
    raw = "Scheme Code;Scheme Name\n1;Fund ₹\n".encode("utf-8")
    res = archive.Archive("https://script.google.com/macros/s/x/exec", "s" * 20, session=s).put_daily(date(2026, 9, 26), raw)
    assert res["stored"] is True
    body = s.bodies[0]
    assert body["action"] == "putDaily" and body["secret"] == "s" * 20 and body["date"] == "2026-09-26"
    assert gzip.decompress(base64.b64decode(body["data"])) == raw
    assert body["md5"] == hashlib.md5(raw).hexdigest() and body["size"] == len(raw)


def test_retries_a_passing_failure_but_not_a_refusal():
    s = FakeSession([requests.ConnectionError("reset"), Resp(503, None), ok(stored=False, name="n")])
    a = archive.Archive("u", "s" * 20, session=s)
    assert a.put_daily(date(2026, 9, 26), b"x")["name"] == "n"
    assert len(s.bodies) == 3

    s = FakeSession([Resp(200, {"ok": False, "app": archive.APP, "error": "The secret doesn't match"})])
    with pytest.raises(archive.ArchiveError, match="doesn't match"):
        archive.Archive("u", "s" * 20, session=s).put_daily(date(2026, 9, 26), b"x")
    assert len(s.bodies) == 1, "a refusal isn't retried"


def test_a_different_script_or_a_web_page_is_explained():
    s = FakeSession([Resp(200, {"ok": False, "error": "Bad secret"})])
    with pytest.raises(archive.ArchiveError, match="different Apps Script"):
        archive.Archive("u", "s" * 20, session=s).call("status")
    s = FakeSession([Resp(200, ValueError("html"), text="<html><title>Oops</title></html>")] * 3)
    with pytest.raises(archive.ArchiveError, match="Anyone"):
        archive.Archive("u", "s" * 20, session=s).call("status")


@pytest.mark.parametrize("text,url,expect,final", [
    ("<html><head><title>Sign in - Google Accounts</title></head></html>", "https://accounts.google.com/v3/signin/identifier?continue=x",
     "asked for a sign-in", True),
    ("<html><title>Error</title><body>Script function not found: doPost</body></html>", "https://script.google.com/macros/s/x/exec",
     "doesn't contain Archive.gs", True),
    ("<html><title>Error</title><body>Authorization is required to perform that action.</body></html>", "https://script.google.com/macros/s/x/exec",
     "isn't authorised yet", True),
    ("<html><title>Apps Script</title></html>", "https://script.google.com/home/projects/abc/edit",
     "editor's address", True),
    ("<html><title>Server Error</title></html>", "https://script.google.com/macros/s/x/exec",
     "private browser window", False),
])
def test_a_web_page_answer_names_the_cause(text, url, expect, final):
    s = FakeSession([Resp(200, ValueError("html"), text=text, url=url)] * 3)
    with pytest.raises(archive.ArchiveError, match=expect) as e:
        archive.Archive("u", "s" * 20, session=s).put_daily(date(2026, 9, 26), b"x")
    assert e.value.final is final
    assert len(s.bodies) == (1 if final else 3), "a cause that won't change isn't retried"
    assert "s" * 20 not in str(e.value), "the secret never appears in a message"


def write_cache(root, n=60):
    (root / "nav").mkdir(parents=True)
    files = {"index.json": json.dumps({str(c): {"f": "2013-01-02"} for c in range(n)}).encode()}
    for c in range(n):
        # varied content so it doesn't compress to nothing
        data = json.dumps({"c": c, "s": "2013-01-02", "t": [0] + [1 + (i * c) % 3 for i in range(3000)],
                           "v": [round(10 + i * 0.013 + (c * i) % 7 * 0.001, 4) for i in range(3001)]}).encode()
        files[f"nav/{c}.json"] = data
        (root / "nav" / f"{c}.json").write_bytes(data)
    (root / "index.json").write_bytes(files["index.json"])
    return files


def test_history_parts_hold_every_file_exactly(tmp_path):
    files = write_cache(tmp_path)
    parts = archive.history_parts(tmp_path, part_bytes=200_000)
    assert len(parts) > 1
    back = {}
    for blob, count in parts:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            members = tar.getmembers()
            assert len(members) == count
            for m in members:
                back[m.name] = tar.extractfile(m).read()
    assert back == files
    assert all(len(b) < 200_000 * 1.6 for b, _ in parts), "parts stay near the size asked for"


def test_snapshot_sends_parts_then_commits(tmp_path):
    write_cache(tmp_path, n=10)
    s = FakeSession(handler=lambda b: ok(stored=True, parts=b.get("parts")))
    archive.Archive("u", "s" * 20, session=s).put_snapshot(tmp_path, "2026-10-01", 50_000, {"funds": 10})
    puts = [b for b in s.bodies if b["action"] == "snapshotPut"]
    assert [b["part"] for b in puts] == list(range(1, len(puts) + 1))
    assert all(b["parts"] == len(puts) and b["id"] == "2026-10-01" for b in puts)
    for b in puts:
        assert hashlib.sha256(base64.b64decode(b["data"])).hexdigest() == b["sha256"]
    commit = s.bodies[-1]
    assert commit["action"] == "snapshotCommit" and commit["parts"] == len(puts)
    assert commit["manifest"]["funds"] == 10 and len(commit["manifest"]["parts"]) == len(puts)


class FakeArchive:
    def __init__(self, latest=None, fail_daily=False, fail_snapshot=False):
        self.latest, self.fail_daily, self.fail_snapshot = latest, fail_daily, fail_snapshot
        self.daily, self.snapshots = [], []

    def put_daily(self, day, raw):
        if self.fail_daily:
            raise archive.ArchiveError("couldn't reach the archive script")
        self.daily.append((day, raw))
        return {"stored": True, "name": f"NAVAll-{day}.txt.gz", "snapshot": {"id": self.latest} if self.latest else None}

    def put_snapshot(self, cache_dir, snap_id, part_bytes, info):
        if self.fail_snapshot:
            raise archive.ArchiveError("Parts missing")
        self.snapshots.append((snap_id, info, sorted(p.name for p in (cache_dir / "nav").glob("*.json"))))
        return {"parts": 2}


def build_with(tmp_path, arch, net=None):
    out = tmp_path / "site"
    out.mkdir(exist_ok=True)
    return build.run(cfg(), tmp_path / "cache", out, net or FakeNet(), today=TODAY, archive=arch)


def test_a_build_stores_the_file_and_a_first_history_copy(tmp_path):
    arch = FakeArchive()
    meta = build_with(tmp_path, arch)
    net_text = FakeNet().navall()[0]
    assert arch.daily == [(TODAY, net_text.encode("utf-8"))]
    snap_id, info, files = arch.snapshots[0]
    assert snap_id == TODAY.isoformat() and info["nav_date"] == NAV_DATE.isoformat()
    assert files == sorted(f"{c}.json" for c in FUNDS if c != 104), "the tracked funds' history"
    assert meta["archive"]["ok"] is True
    assert meta["archive"]["daily"] == {"name": f"NAVAll-{TODAY}.txt.gz", "stored": True}
    assert meta["archive"]["snapshot"]["stored"] is True


def test_history_goes_up_once_a_month(tmp_path):
    arch = FakeArchive(latest=date(2026, 9, 10).isoformat())
    meta = build_with(tmp_path, arch)
    assert arch.snapshots == []
    assert meta["archive"]["snapshot"] == {"latest": "2026-09-10", "due": False}
    arch = FakeArchive(latest=date(2026, 8, 20).isoformat())
    build_with(tmp_path, arch)
    assert len(arch.snapshots) == 1


def test_the_raw_bytes_are_archived_when_the_net_has_them(tmp_path):
    class RawNet(FakeNet):
        navall_bytes = b"\xef\xbb\xbfScheme Code;exact bytes"
    arch = FakeArchive(latest=TODAY.isoformat())
    build_with(tmp_path, arch, RawNet())
    assert arch.daily[0][1] == b"\xef\xbb\xbfScheme Code;exact bytes"


def test_archive_trouble_never_stops_the_build(tmp_path):
    meta = build_with(tmp_path, FakeArchive(fail_daily=True))
    assert meta["archive"]["ok"] is False and "reach" in meta["archive"]["daily"]["error"]
    assert "didn't answer" in meta["archive"]["snapshot"]["skipped"]
    assert (tmp_path / "site" / "funds.json").exists()
    meta = build_with(tmp_path, FakeArchive(fail_snapshot=True))
    assert meta["archive"]["ok"] is False and "Parts missing" in meta["archive"]["snapshot"]["error"]


def test_the_file_is_archived_even_when_the_build_then_stops(tmp_path):
    arch = FakeArchive()
    with pytest.raises(build.BuildError):
        build.run(cfg(), tmp_path / "cache", tmp_path, FakeNet(), today=TODAY.replace(month=12), archive=arch)
    assert len(arch.daily) == 1 and arch.snapshots == []


def test_without_secrets_there_is_no_archive(monkeypatch, tmp_path):
    monkeypatch.delenv("ARCHIVE_URL", raising=False)
    monkeypatch.delenv("ARCHIVE_SECRET", raising=False)
    assert archive.Archive.from_env() is None
    assert build_with(tmp_path, None)["archive"] == {"configured": False}
    monkeypatch.setenv("ARCHIVE_URL", "https://script.google.com/macros/s/x/exec")
    monkeypatch.setenv("ARCHIVE_SECRET", "s" * 20)
    assert isinstance(archive.Archive.from_env(), archive.Archive)
