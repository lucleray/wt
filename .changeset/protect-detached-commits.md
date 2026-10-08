---
"@lucleray/wt": minor
---

`wt down` and `wt cleanup` now refuse to release a worktree with commits on a detached HEAD that no branch, remote ref, or tag contains. `wt down --force` pins those commits under `refs/wt/rescue/<id>-<timestamp>` before recycling. The check is skipped when HEAD still equals the warmed base commit, so the common case stays free and `wt list` is unaffected.
