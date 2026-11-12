---
"@lucleray/wt": patch
---

The skill and usage docs no longer store the worktree path in a shell variable named `path`: in zsh that variable is tied to `PATH`, so every command after it failed with "command not found".
