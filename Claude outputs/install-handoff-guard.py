#!/usr/bin/env python3
"""Installs the handoff guard into a Claude Code config folder. Safe to run twice.

    python install-handoff-guard.py            -> installs into ~/.claude
    python install-handoff-guard.py <folder>   -> installs into that folder (a copy, for review)

It makes long, single sessions cheap without anyone thinking about it:
  1. hooks/handoff-guard.sh, a Stop hook: when files changed and HANDOFF.md is more than 30 minutes behind, Claude
     is asked to update it; when HANDOFF.md is over 30 KB, Claude is asked (once a day at most) to move old and
     resolved entries to old-handoff/, word for word.
  2. a SessionStart hook for "compact": after every compaction, MAP.md is put back in context.
  3. "autoCompactWindow": 200000, added only if the key is absent.
  4. a "Long sessions" section and "Compact instructions" appended to CLAUDE.md.
Both hooks do nothing in a project that has no HANDOFF.md / MAP.md at its root.
A backup of each changed file is written next to it (.bak-handoff-guard).
"""
import json
import shutil
import sys
from pathlib import Path

GUARD = r'''#!/usr/bin/env bash
# handoff-guard: Stop hook. Keeps HANDOFF.md current and light without anyone thinking about it, so a compaction
# (automatic, idle or manual) never loses project state. No-op in a project that has no HANDOFF.md at its root.
#  - stale: files changed after HANDOFF.md was last written, and nothing was asked in the last HANDOFF_EVERY
#    seconds (default 1800): asks Claude to update it.
#  - heavy: HANDOFF.md is larger than HANDOFF_MAX_KB (default 30): asks Claude, at most once a day, to move old and
#    resolved entries to old-handoff/, word for word.
input=$(cat)
root="${CLAUDE_PROJECT_DIR:-$PWD}"
command -v cygpath >/dev/null 2>&1 && root=$(cygpath -u "$root" 2>/dev/null || printf '%s' "$root")
handoff="$root/HANDOFF.md"
[ -f "$handoff" ] || exit 0

# Claude is already continuing because of a stop hook: let it stop
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac

every="${HANDOFF_EVERY:-1800}"
max_kb="${HANDOFF_MAX_KB:-30}"
now=$(date +%s)
key=$(printf '%s' "$root" | md5sum | cut -c1-12)
marker="${TMPDIR:-/tmp}/handoff-guard-$key"
marker_archive="${TMPDIR:-/tmp}/handoff-guard-$key-archive"
mtime() { stat -c %Y "$1" 2>/dev/null || echo "$2"; }

ask=""

# heavy
size_kb=$(( $(wc -c < "$handoff") / 1024 ))
if [ "$size_kb" -gt "$max_kb" ] && [ $((now - $(mtime "$marker_archive" 0))) -ge 86400 ]; then
  : > "$marker_archive"
  ask="HANDOFF.md is ${size_kb} KB (limit ${max_kb} KB). Lighten it: move every old and resolved item (finished tasks, closed decisions, dated entries that are done or superseded) to old-handoff/HANDOFF-archive-$(date +%F).md, creating the folder if needed. Move the text word for word, with a shell command that cuts the line ranges rather than retyping them; delete nothing and summarise nothing away. If a fact that is still true lives only in an old entry, fold it into the current-state sections first. HANDOFF.md keeps: the current state, open tasks, open decisions, and one line pointing to the archive. "
fi

# stale
last=$(mtime "$handoff" "$now")
asked=$(mtime "$marker" 0)
[ "$asked" -gt "$last" ] && last=$asked
if [ $((now - last)) -ge "$every" ]; then
  changed=$(find "$root" \
    \( -name .git -o -name node_modules -o -name .claude -o -name .impeccable -o -name scratchpad -o -name old-handoff \
       -o -name dist -o -name build -o -name .next -o -name .vercel -o -name __pycache__ \) -prune \
    -o -type f -newer "$handoff" ! -name MAP.md -print -quit 2>/dev/null)
  if [ -n "$changed" ]; then
    : > "$marker"
    name=$(basename "$changed" | tr -cd 'A-Za-z0-9._ -')
    ask="${ask}Files changed since HANDOFF.md was last updated (for example ${name}). Update HANDOFF.md now: the date in its title, the current state, and one short dated entry for what changed. A task that is now resolved goes to the archive in old-handoff/, not into HANDOFF.md. Update MAP.md only if a file, folder or reference moved. "
  fi
fi

[ -n "$ask" ] || exit 0
printf '{"decision":"block","reason":"%sThen stop."}\n' "$ask"
exit 0
'''

COMPACT_CMD = (
    '[ ! -f "$CLAUDE_PROJECT_DIR/MAP.md" ] || { echo \'The conversation was just compacted. The project map '
    '(MAP.md) follows. HANDOFF.md holds the state: open the sections the task needs, not the whole file.\'; '
    'echo; cat "$CLAUDE_PROJECT_DIR/MAP.md"; }'
)

CLAUDE_MD = """
## Long sessions (one session per project)
- Applies to any project with `MAP.md` and `HANDOFF.md` at its root. Compaction is automatic; I never ask for a checkpoint.
- When a hook asks you to update `HANDOFF.md`, do it at once: the date in its title, the current state, one short dated entry. Touch `MAP.md` only if a file, folder or reference moved.
- After a compaction a hook re-injects `MAP.md`. Open the `HANDOFF.md` sections the task needs; do not re-read the whole file.
- `HANDOFF.md` stays light: the current state, open tasks and open decisions only. Old and resolved items (finished tasks, closed decisions, dated entries that are done or superseded) move to `old-handoff/HANDOFF-archive-<date>.md`, word for word, with a shell command rather than retyping. Never delete or summarise them away; fold a still-true fact into the current state first.

# Compact instructions
Keep: the current task and its acceptance criteria, decisions with their reasons, files touched, commands that worked, open errors.
Drop: file contents, tool output, logs, abandoned approaches. `MAP.md` and `HANDOFF.md` hold the rest.
"""


def backup(path: Path) -> None:
    bak = path.with_name(path.name + '.bak-handoff-guard')
    if path.exists() and not bak.exists():
        shutil.copyfile(path, bak)


def main() -> int:
    target = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / '.claude'
    if not target.is_dir():
        print(f'Not a folder: {target}')
        return 1
    did = []

    # 1. the Stop hook script, always with LF line endings (it runs in Git Bash)
    script = target / 'hooks' / 'handoff-guard.sh'
    script.parent.mkdir(exist_ok=True)
    body = GUARD.lstrip('\n').encode('utf-8')
    if not script.exists() or script.read_bytes() != body:
        script.write_bytes(body)
        did.append(f'wrote {script}')

    # 2 and 3. settings.json
    settings = target / 'settings.json'
    text = settings.read_text(encoding='utf-8-sig') if settings.exists() else '{}\n'
    data = json.loads(text)
    before = json.dumps(data, sort_keys=True)
    hooks = data.setdefault('hooks', {})
    if 'handoff-guard.sh' not in json.dumps(hooks.get('Stop', [])):
        hooks.setdefault('Stop', []).append({'hooks': [{
            'type': 'command',
            'command': f'bash "{script.as_posix()}"',
            'timeout': 15,
            'statusMessage': 'Checking the handoff',
        }]})
    if not any(h.get('matcher') == 'compact' and 'MAP.md' in json.dumps(h) for h in hooks.get('SessionStart', [])):
        hooks.setdefault('SessionStart', []).append({'matcher': 'compact', 'hooks': [{
            'type': 'command', 'command': COMPACT_CMD, 'timeout': 5,
        }]})
    data.setdefault('autoCompactWindow', 200000)
    if json.dumps(data, sort_keys=True) != before:
        backup(settings)
        settings.write_bytes((json.dumps(data, indent=2, ensure_ascii=False) + '\n').encode('utf-8'))
        did.append(f'patched {settings}')

    # 4. CLAUDE.md, keeping its line endings
    claude_md = target / 'CLAUDE.md'
    raw = claude_md.read_bytes() if claude_md.exists() else b''
    if b'## Long sessions (one session per project)' not in raw:
        crlf = b'\r\n' in raw
        current = raw.decode('utf-8').replace('\r\n', '\n')
        merged = (current.rstrip('\n') + '\n' if current.strip() else '') + CLAUDE_MD.lstrip('\n' if not current.strip() else '')
        backup(claude_md)
        claude_md.write_bytes((merged.replace('\n', '\r\n') if crlf else merged).encode('utf-8'))
        did.append(f'appended the Long sessions rules to {claude_md}')

    print('\n'.join(did) if did else 'Already installed: nothing to change.')
    print('Start a new Claude Code session for the hooks and CLAUDE.md to load.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
