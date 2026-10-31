"""CLI: `python3 -m parallax_transpiler build <project_dir> <out_dir> [--json]`."""

import argparse
import json
import sys
from pathlib import Path

from parallax_transpiler.build import build


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="parallax_transpiler")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="compile a project's .py files to ES modules")
    b.add_argument("project_dir", type=Path)
    b.add_argument("out_dir", type=Path)
    b.add_argument("--json", action="store_true", help="print diagnostics as JSON")
    args = parser.parse_args(argv)
    results = build(args.project_dir, args.out_dir)
    diagnostics = [d for r in results for d in r.diagnostics]
    if args.json:
        print(json.dumps([d.to_json() for d in diagnostics], indent=2))
    else:
        for d in diagnostics:
            print(d.format(), file=sys.stderr)
        ok = sum(1 for r in results if r.js is not None)
        print(f"{ok}/{len(results)} modules compiled, {len(diagnostics)} diagnostics", file=sys.stderr)
    return 1 if diagnostics else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
