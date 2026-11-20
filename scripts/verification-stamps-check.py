#!/usr/bin/env python3
"""Verification stamp checker. OBSERVE MODE: never blocks, always exits 0."""
import argparse, json, os, re, subprocess, datetime, sys

def run(cmd, cwd=None):
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120,
                              env={**os.environ, "CLICOLOR_FORCE": "0", "NO_COLOR": "1"}).stdout
    except Exception:
        return ""

def job_shas(jobs):
    out = {}
    if not os.path.isdir(jobs):
        return out
    for n in os.listdir(jobs):
        try:
            with open(os.path.join(jobs, n, "run.log"), errors="replace") as f:
                m = re.search(r"^start \S+ name=\S+ sha=([0-9a-f]{40})", f.readline())
            if m:
                out[n] = m.group(1)
        except OSError:
            pass
    return out

TRAILER = re.compile(r"^Verified:\s*(.+?)\s*$", re.M)

def classify(sha, msg, jobs):
    m = TRAILER.findall(msg)
    if not m:
        return "unstamped", ""
    v = m[-1]
    if v.lower().startswith("none"):
        return "none", v
    p = v.split()
    if len(p) < 2 or p[0] not in ("pa-ci", "pa-ci-ab", "pa-job", "pa-e2e"):
        return "invalid", v + " (bad format)"
    for name in (p[1], p[1] + "-pr"):
        if jobs.get(name) == sha:
            return "valid", v
    missing = p[1] not in jobs and p[1] + "-pr" not in jobs
    return "invalid", v + (" (job missing)" if missing else " (other sha)")

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--days", type=int, default=1)
    a.add_argument("--repo", default="/home/paperclip/upstream-paperclip")
    a.add_argument("--jobs", default="/home/paperclip/work/pa-ci/jobs")
    a.add_argument("--out", default="/home/paperclip/work/verification-stamps")
    a.add_argument("--date", default=datetime.date.today().isoformat())
    o = a.parse_args()
    jobs = job_shas(o.jobs)
    run(["git", "fetch", "-q", "origin", "master"], o.repo)
    rows = []
    log = run(["git", "log", f"--since={o.days} days ago", "--format=%H%x1f%s%x1f%B%x1e", "origin/master"], o.repo)
    for rec in (x for x in log.split("\x1e") if x.strip()):
        sha, subj, body = rec.strip().split("\x1f", 2)
        rows.append(("master", sha, subj) + classify(sha, body, jobs))
    prs = json.loads(run(["gh", "pr", "list", "--json", "number,headRefOid", "--limit", "100"], o.repo) or "[]")
    for pr in prs:
        sha = pr["headRefOid"]
        body = run(["git", "log", "-1", "--format=%B", sha], o.repo)
        if not body:
            run(["git", "fetch", "-q", "origin", f"pull/{pr['number']}/head"], o.repo)
            body = run(["git", "log", "-1", "--format=%B", sha], o.repo)
        rows.append((f"PR#{pr['number']}", sha, body.split("\n")[0]) + classify(sha, body, jobs))
    cnt = {}
    for r in rows:
        cnt[r[3]] = cnt.get(r[3], 0) + 1
    summary = f"verification-stamps {o.date}: {len(rows)} checked " + " ".join(f"{k}={v}" for k, v in sorted(cnt.items()))
    os.makedirs(o.out, exist_ok=True)
    with open(os.path.join(o.out, o.date + ".txt"), "w") as f:
        f.write(summary + "\n")
        for r in rows:
            f.write("\t".join([r[0], r[1][:12], r[3], r[4], r[2][:80]]) + "\n")
    print(summary)

try:
    main()
except Exception as e:
    print("verification-stamps: probe error (observe only):", e)
sys.exit(0)
