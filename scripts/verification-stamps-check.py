#!/usr/bin/env python3
"""Verification stamp checker. OBSERVE MODE: never blocks, always exits 0."""
import argparse, json, os, re, subprocess, datetime, sys

def run(cmd, cwd=None):
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120,
                              env={**os.environ, "CLICOLOR_FORCE": "0", "NO_COLOR": "1"}).stdout
    except Exception:
        return None

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

TRAILER = re.compile(r"^Verified:[ \t]*(.+?)[ \t]*$", re.M)
TOOLS = ("pa-ci", "pa-ci-ab", "pa-job", "pa-e2e")
STAMP = re.compile(r"^(pa-ci|pa-ci-ab|pa-job|pa-e2e) ([A-Za-z0-9._-]+)$")
NONE = re.compile(r"^none - \S.*$")

def classify(sha, msg, jobs):
    if msg is None:
        return "probe-error", "could not read commit message"
    m = TRAILER.findall(msg)
    if not m:
        return "unstamped", ""
    v = m[-1]
    if NONE.match(v):
        return "none", v
    t = STAMP.match(v)
    if not t:
        return "invalid", v + " (bad format)"
    tool, name = t.groups()
    # pa-ci-ab: NAME given, the PR side job is NAME-pr. Other tools: exact name.
    job = name + "-pr" if tool == "pa-ci-ab" else name
    if job not in jobs:
        return "invalid", v + " (job missing)"
    return ("valid", v) if jobs[job] == sha else ("invalid", v + " (other sha)")

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
    if log is None:
        rows.append(("master", "-", "git log failed", "probe-error", "could not read master log"))
    for rec in (x for x in (log or "").split("\x1e") if x.strip()):
        sha, subj, body = rec.strip().split("\x1f", 2)
        rows.append(("master", sha, subj) + classify(sha, body, jobs))
    raw = run(["gh", "api", "--paginate", "repos/{owner}/{repo}/pulls?state=open&per_page=100",
               "--jq", '.[] | "\\(.number) \\(.head.sha)"'], o.repo)
    prs = [ln.split() for ln in (raw or "").splitlines() if ln.strip()]
    if raw is None:
        rows.append(("PRlist", "-", "gh pr list failed", "probe-error", "could not list PRs"))
    for number, sha in prs:
        body = run(["git", "log", "-1", "--format=%B", sha], o.repo)
        if not body:
            run(["git", "fetch", "-q", "origin", f"pull/{number}/head"], o.repo)
            body = run(["git", "log", "-1", "--format=%B", sha], o.repo)
        rows.append((f"PR#{number}", sha, (body or "").split("\n")[0]) + classify(sha, body or None, jobs))
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

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("verification-stamps: probe error (observe only):", e)
    sys.exit(0)
