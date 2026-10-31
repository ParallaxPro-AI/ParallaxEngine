"""`python3 -m parallax_transpiler.extract <project> [--out PATH|-] [--sdk DIR]`

Writes the declarations document to <project>/build/declarations.json (or PATH; `-` for
stdout). Exits 1 when any error diagnostic was found, 0 otherwise; the document is
written either way so tools can show every diagnostic at once.
"""

import argparse
import json
import sys
from pathlib import Path

from parallax_transpiler.extract.document import extract_project
from parallax_transpiler.extract.sources import DEFAULT_SDK_DIR


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="parallax_transpiler.extract", description=__doc__.splitlines()[0])
    parser.add_argument("project", type=Path)
    parser.add_argument("--out", default=None, help="output file, or - for stdout")
    parser.add_argument("--sdk", type=Path, default=DEFAULT_SDK_DIR)
    args = parser.parse_args(argv)
    document = extract_project(args.project.resolve(), args.sdk.resolve())
    text = json.dumps(document, indent=1, ensure_ascii=False)
    if args.out == "-":
        sys.stdout.write(text)
    else:
        out = Path(args.out) if args.out else args.project / "build" / "declarations.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", encoding="utf-8")
    errors = [d for d in document["diagnostics"] if d["severity"] == "error"]  # type: ignore[union-attr,index]
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
