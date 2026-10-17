"""Lee rutas cambiadas por stdin y emite los workflows (claves de areas.json) cuyas rutas las cubren.

Semántica de los filtros `paths` de GitHub Actions: `*` no cruza `/`, `**` sí.
"""
import json
import re
import sys


def glob_to_regex(glob: str) -> re.Pattern:
    out = []
    i = 0
    while i < len(glob):
        if glob.startswith("**", i):
            out.append(".*")
            i += 2
        elif glob[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(glob[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def main() -> None:
    areas = json.load(open(sys.argv[1], encoding="utf-8"))["areas"]
    compiled = {name: [glob_to_regex(g) for g in globs] for name, globs in areas.items()}
    changed = [line.strip() for line in sys.stdin if line.strip()]
    for name, patterns in compiled.items():
        if any(p.match(path) for path in changed for p in patterns):
            print(name)


if __name__ == "__main__":
    main()
