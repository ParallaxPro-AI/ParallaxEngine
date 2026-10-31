"""Compile one Parallax Python file: the safety pass, then the emit pass. A file with any
diagnostic produces no module."""

import ast
from dataclasses import dataclass, field

from parallax_transpiler.diagnostics import Diagnostic
from parallax_transpiler.emit import ModuleEmitter
from parallax_transpiler.project import ProjectIndex
from parallax_transpiler.safety import check_safety
from parallax_transpiler.source_map import strip_marks


@dataclass(frozen=True)
class CompiledModule:
    path: str
    js: str | None
    diagnostics: list[Diagnostic]
    # The Python line (1-based; 0 = none) of each line of `js` (source_map.py).
    lines: list[int] = field(default_factory=list)


def compile_module(source: str, path: str, index: ProjectIndex) -> CompiledModule:
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as e:
        return CompiledModule(path, None, [Diagnostic(
            code="PP6000", message=f"Syntax error: {e.msg}", path=path, line=e.lineno or 0,
            column=e.offset or 0, fix="Fix the Python syntax.")])
    diagnostics = check_safety(source, path, index.local_packages())
    emitter = ModuleEmitter(source, path, index)
    js, lines = strip_marks(emitter.emit(tree))
    diagnostics = sorted([*diagnostics, *emitter.diagnostics], key=lambda d: (d.line, d.column, d.code))
    if diagnostics:
        return CompiledModule(path, None, diagnostics)
    return CompiledModule(path, js, diagnostics, lines)
