# external-memory

Loads sidecar `AGENTS.md` files from an external memory repository instead of
from the project tree.

Config path:

```text
~/.config/pi_extensions/external_memory.toml
```

Example:

```toml
[[project]]
name = "my-project"
memory_root = "/home/sanjit/memory/my-project"

[[mapping]]
directory = "/home/sanjit/git/my-project"
project = "my-project"
```

When pi is started under a configured `directory`, project paths are mapped into
the configured `memory_root`.

For example, reading:

```text
/home/sanjit/git/my-project/sub/dir/file.txt
```

will look for unsent memory files at:

```text
/home/sanjit/memory/my-project/AGENTS.md
/home/sanjit/memory/my-project/sub/AGENTS.md
/home/sanjit/memory/my-project/sub/dir/AGENTS.md
```

Behavior:

- At the start of each turn, injects unsent memory for paths mentioned in the
  prompt and paths touched earlier in the session.
- After successful `read` results, appends newly discovered memory to the tool
  result so the model can use it in the same turn.
- Records touched paths from `read`, `edit`, and `write`.
- Deduplicates sent memory files for the whole session, persisted via custom
  session entries so `/reload` does not resend the same `AGENTS.md` files.
