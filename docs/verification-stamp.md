# Per-commit verification stamp (observe mode)

Every commit on a PR branch carries one trailer line:

    Verified: <tool> <job-name>
    Verified: none - <one-line reason>

- `<tool>` is one of `pa-ci`, `pa-ci-ab`, `pa-job`, `pa-e2e`.
- The job must have run on exactly this commit (full sha).
- For `pa-ci-ab`, give the NAME you passed; the PR side job is `<NAME>-pr`.
- A commit cannot contain its own sha. So the stamp is added by an amend
  after the job ran. Use `Verified: none - <reason>` for commits that are
  only tested later as part of the final head.
- The final head commit of a PR should carry a valid stamp.

## Checker (observe only)

`scripts/verification-stamps-check.py` lists new master commits and open PR
heads and labels each: `valid`, `none` (with reason), `invalid`, `unstamped`.
It runs once a day, writes `/home/paperclip/work/verification-stamps/<date>.txt`,
and always exits 0. It blocks no commit, PR, merge or CI run.
