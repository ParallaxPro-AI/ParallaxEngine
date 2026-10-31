"""Finding and parsing Python: a project's modules and the SDK's stubs.

Module names follow Python's own rules: `game/behaviors/orb.py` is `game.behaviors.orb`,
`game/__init__.py` is `game`, and `sdk/parallax/physics.pyi` is `parallax.physics`.
"""

import ast
from dataclasses import dataclass
from pathlib import Path

from parallax_transpiler.diagnostics import Diagnostic

# Folders that hold no game declarations: playtests use `parallax.test`, the rest is output.
SKIPPED_DIRS = frozenset({"tests", "build", "node_modules", "__pycache__"})

DEFAULT_SDK_DIR = Path(__file__).resolve().parents[4] / "sdk"


@dataclass
class Module:
    name: str
    path: str
    """Project-relative POSIX path (SDK stubs: `sdk/parallax/<file>.pyi`)."""
    tree: ast.Module
    sdk: bool
    feature: str | None
    """The feature folder the module lives in (`features/<feature>/…`), if any."""
    package: bool
    source: str


def _module_name(relative: Path) -> tuple[str, bool]:
    parts = list(relative.with_suffix("").parts)
    package = parts[-1] == "__init__"
    if package:
        parts = parts[:-1]
    return ".".join(parts), package


def _feature_of(relative: Path) -> str | None:
    parts = relative.parts
    if len(parts) >= 3 and parts[0] == "features":
        return parts[1]
    return None


def _parse(source: str, path: str, diagnostics: list[Diagnostic]) -> ast.Module | None:
    try:
        return ast.parse(source, filename=path)
    except SyntaxError as error:
        diagnostics.append(Diagnostic(
            code="PP1100",
            message=f"Python syntax error: {error.msg}",
            path=path,
            line=error.lineno or 1,
            column=(error.offset or 1) - 1,
            fix="Fix the syntax; the declarations in this file can't be read until it parses.",
        ))
        return None


def load_project_modules(root: Path, diagnostics: list[Diagnostic]) -> dict[str, Module]:
    """Every `.py` file under the project root except playtests and generated output."""
    modules: dict[str, Module] = {}
    for file in sorted(root.rglob("*.py")):
        relative = file.relative_to(root)
        if any(part in SKIPPED_DIRS or part.startswith(".") for part in relative.parts[:-1]):
            continue
        path = relative.as_posix()
        source = file.read_text(encoding="utf-8")
        tree = _parse(source, path, diagnostics)
        if tree is None:
            continue
        name, package = _module_name(relative)
        modules[name] = Module(name, path, tree, False, _feature_of(relative), package, source)
    return modules


def load_sdk_modules(sdk_dir: Path, diagnostics: list[Diagnostic]) -> dict[str, Module]:
    """The `parallax` stubs. They are the API contract, so they are read, not hard-coded."""
    modules: dict[str, Module] = {}
    for file in sorted((sdk_dir / "parallax").rglob("*.pyi")):
        relative = file.relative_to(sdk_dir)
        path = f"sdk/{relative.as_posix()}"
        source = file.read_text(encoding="utf-8")
        tree = _parse(source, path, diagnostics)
        if tree is None:
            continue
        name, package = _module_name(relative)
        modules[name] = Module(name, path, tree, True, None, package, source)
    return modules
