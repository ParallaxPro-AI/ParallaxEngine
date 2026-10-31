"""`python3 -m parallax_transpiler build <project_dir> <out_dir>`: every project `.py` file
→ `<out_dir>/<path>.js` with its source map `<path>.js.map` (JS lines → .py lines; its
`sources` entry is the .py file relative to the map), plus `<out_dir>/manifest.json`
(modules, entry, diagnostics)."""

import json
import os
from pathlib import Path

from parallax_transpiler.compile import CompiledModule, compile_module
from parallax_transpiler.project import ProjectIndex, js_path
from parallax_transpiler.source_map import map_comment, source_map

ENTRY = "game/main.py"


def build(project_dir: Path, out_dir: Path) -> list[CompiledModule]:
    index = ProjectIndex.scan(project_dir)
    sources = {path: (project_dir / path).read_text() for path in sorted(index.modules.values())}
    results = [compile_module(text, path, index) for path, text in sources.items()]
    for result in results:
        if result.js is not None:
            target = out_dir / js_path(result.path)
            target.parent.mkdir(parents=True, exist_ok=True)
            map_file = target.name + ".map"
            source = Path(os.path.relpath((project_dir / result.path).resolve(), target.parent.resolve())).as_posix()
            target.write_text(result.js + map_comment(map_file))
            (target.parent / map_file).write_text(source_map(target.name, source, sources[result.path], result.lines))
    manifest = {
        "entry": js_path(ENTRY) if ENTRY in index.modules.values() else None,
        "modules": [{"source": r.path, "output": js_path(r.path) if r.js is not None else None} for r in results],
        "diagnostics": [d.to_json() for r in results for d in r.diagnostics],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return results
