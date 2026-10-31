"""The project's own modules, and how a Python import becomes an ES module specifier.

  from parallax import X            →  import { X } from 'parallax'
  from parallax.physics import X    →  import { X } from 'parallax/physics'
  from project import Prefabs       →  import { Prefabs } from 'project'
  from game.rules import f          →  import { f } from '../rules.js'   (relative, with .js)
  from game.chess import moves      →  import * as moves from './chess/moves.js'  (a submodule)
"""

import ast
import posixpath
from dataclasses import dataclass, field
from pathlib import Path

SDK_PACKAGES = frozenset({"parallax", "project"})

# The SDK's submodules — one per `sdk/parallax/<name>.pyi`, read from the SDK itself so the
# list can't drift: `from parallax import physics` binds the module `parallax/physics`, not a
# name exported by `parallax`.
SDK_DIR = Path(__file__).resolve().parents[3] / "sdk" / "parallax"
SDK_SUBMODULES = frozenset(p.stem for p in SDK_DIR.glob("*.pyi") if p.stem != "__init__")
if not SDK_SUBMODULES:
    raise RuntimeError(f"No SDK stubs found in {SDK_DIR}: the transpiler resolves parallax.* modules from them")

# SDK names that were renamed or moved: (module, old name) → the new spelling, so an old
# import or `module.old` is a PP6012 naming its replacement instead of an unknown name.
SDK_RENAMED: dict[tuple[str, str], str] = {
    ("parallax.plugins", "narrative"): "parallax.plugins.story()",
    ("parallax", "DialoguePanel"): "parallax.story.DialoguePanel (from parallax.story import DialoguePanel)",
    ("parallax.combat", "Hit"): "parallax.combat.DamageHit",
    ("parallax.combat", "Effects"): "parallax.combat.StatusEffects",
    ("parallax", "Effects"): "parallax.Effect (the built-in 3D effects: \"effect/<name>\" in data, as Synth is \"synth/<name>\")",
    ("parallax.physics", "Hit"): "parallax.physics.RayHit",
    ("parallax.net", "Hit"): "parallax.physics.RayHit",
    ("parallax.voxels", "VoxelApi"): "parallax.voxels.VoxelsApi",
}


@dataclass
class ProjectIndex:
    """Dotted module name → project-relative .py path (packages map to `__init__.py`)."""
    modules: dict[str, str] = field(default_factory=dict)
    packages: set[str] = field(default_factory=set)
    # Package → names its `__init__.py` binds (they win over a same-named submodule).
    init_bindings: dict[str, set[str]] = field(default_factory=dict)

    @classmethod
    def from_paths(cls, paths: list[str]) -> "ProjectIndex":
        index = cls()
        for path in sorted(paths):
            parts = path[:-3].split("/")
            if parts[-1] == "__init__":
                parts = parts[:-1]
            if parts:
                index.modules[".".join(parts)] = path
            for i in range(1, len(path.split("/"))):
                index.packages.add(".".join(path.split("/")[:i]))
        return index

    @classmethod
    def scan(cls, root: Path) -> "ProjectIndex":
        paths = sorted(p.relative_to(root).as_posix() for p in root.rglob("*.py")
                       if not any(part.startswith(".") or part in ("build", "__pycache__")
                                  for part in p.relative_to(root).parts))
        index = cls.from_paths(paths)
        for path in paths:
            if path.endswith("__init__.py"):
                index.init_bindings[index.module_of(path)] = _top_level_bindings((root / path).read_text())
        return index

    def local_packages(self) -> frozenset[str]:
        return frozenset(name.split(".")[0] for name in [*self.modules, *self.packages])

    def module_of(self, path: str) -> str:
        parts = path[:-3].split("/")
        return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)

    def is_package_path(self, path: str) -> bool:
        return path.endswith("/__init__.py") or path == "__init__.py"

    def exists(self, module: str) -> bool:
        return module in self.modules or module in self.packages


def js_path(py_path: str) -> str:
    return py_path[:-3] + ".js"


def relative_specifier(from_py: str, to_py: str) -> str:
    rel = posixpath.relpath(js_path(to_py), posixpath.dirname(from_py) or ".")
    return rel if rel.startswith("../") else f"./{rel}"


def sdk_specifier(module: str) -> str:
    return module.replace(".", "/")


def absolute_module(current_module: str, is_package: bool, level: int, module: str | None) -> str | None:
    """The absolute dotted name of a (possibly relative) `from` import, or None if it
    climbs above the project root."""
    if level == 0:
        return module
    package = current_module.split(".") if is_package else current_module.split(".")[:-1]
    if level - 1 > len(package):
        return None
    base = package[: len(package) - (level - 1)]
    return ".".join([*base, *([module] if module else [])])


def _top_level_bindings(source: str) -> set[str]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    names: set[str] = set()
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(stmt.name)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            names.update(a.asname or a.name.split(".")[0] for a in stmt.names)
        else:
            names.update(n.id for n in ast.walk(stmt) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store))
    return names
