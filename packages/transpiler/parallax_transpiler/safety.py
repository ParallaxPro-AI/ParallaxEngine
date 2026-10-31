"""Safety pass: game code may only reach the SDK, its own modules and a few pure stdlib
modules — never the host.

Compiled Python becomes JavaScript, so an attribute that is harmless in CPython can be an
escape hatch in JS: `"".constructor.constructor("…")()` is `Function("…")()`. This pass
rejects every route to JS internals or the host that can be seen statically. Dynamic
routes it can't see (a computed subscript) are why the runtime also sandboxes game code.
"""

import ast

from parallax_transpiler.diagnostics import Diagnostic

ALLOWED_MODULES = frozenset({
    "parallax", "project",
    "math", "random", "dataclasses", "enum", "typing", "collections",
})

# Stdlib modules people reach for that Parallax Python doesn't provide, with a rewrite.
UNSUPPORTED_MODULE_HINTS: dict[str, str] = {
    "itertools": "itertools is not available: write the loop, or use zip()/enumerate()/a comprehension.",
    "functools": "functools is not available: write the loop or a small helper function.",
    "json": "json is not available: keep data in config/content/resources (the engine loads and saves it).",
}

FORBIDDEN_NAMES = frozenset({
    "eval", "exec", "compile", "open", "input", "breakpoint",
    "__import__", "__builtins__", "globals", "locals", "vars", "memoryview",
})

# Names that mean nothing in Python but reach JavaScript internals once compiled.
JS_INTERNALS = frozenset({
    "constructor", "prototype", "__proto__",
    "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
})

# The only dunder attributes game code may read (calling a parent initializer).
ALLOWED_DUNDER_ATTRIBUTES = frozenset({"__init__"})

DYNAMIC_ATTRIBUTE_BUILTINS = frozenset({"getattr", "setattr", "hasattr", "delattr"})


def check_safety(source: str, path: str, local_packages: frozenset[str] = frozenset()) -> list[Diagnostic]:
    """Diagnostics for every unsafe construct in `source` (empty when it's safe).

    `local_packages` are the project's own top-level packages (e.g. {"game", "features"}),
    which game code may import alongside ALLOWED_MODULES.
    """
    checker = _SafetyChecker(path, ALLOWED_MODULES | local_packages)
    checker.visit(ast.parse(source, filename=path))
    return checker.diagnostics


def _is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__")


class _SafetyChecker(ast.NodeVisitor):
    def __init__(self, path: str, allowed_modules: frozenset[str]) -> None:
        self.path = path
        self.allowed_modules = allowed_modules
        self.diagnostics: list[Diagnostic] = []

    def _report(self, node: ast.AST, code: str, message: str, fix: str) -> None:
        self.diagnostics.append(Diagnostic(
            code=code,
            message=message,
            path=self.path,
            line=getattr(node, "lineno", 0),
            column=getattr(node, "col_offset", 0) + 1,
            fix=fix,
        ))

    def _check_module(self, node: ast.AST, module: str) -> None:
        top = module.split(".")[0]
        if top not in self.allowed_modules:
            allowed = ", ".join(sorted(self.allowed_modules))
            hint = UNSUPPORTED_MODULE_HINTS.get(top)
            prefix = f"{hint} " if hint is not None else ""
            self._report(node, "PP6001", f"Import not allowed: '{module}'",
                         f"{prefix}Game code may import only: {allowed}, and its own modules.")

    def _check_attribute_name(self, node: ast.AST, name: str) -> None:
        if name in JS_INTERNALS:
            self._report(node, "PP6003", f"'{name}' is not accessible from game code",
                         "Remove this access; it reaches JavaScript internals, not Python.")
        elif _is_dunder(name) and name not in ALLOWED_DUNDER_ATTRIBUTES:
            self._report(node, "PP6003", f"Dunder attribute '{name}' is not accessible from game code",
                         "Use the value's public methods; implement dunder methods instead of reading them.")

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._check_module(node, alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level == 0 and node.module is not None:
            self._check_module(node, node.module)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in FORBIDDEN_NAMES:
            self._report(node, "PP6002", f"'{node.id}' is not available in game code",
                         "Game code can only reach the SDK; use the parallax API for this.")

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self._check_attribute_name(node, node.attr)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
            if node.slice.value in JS_INTERNALS:
                self._check_attribute_name(node, node.slice.value)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if isinstance(func, ast.Name) and func.id in DYNAMIC_ATTRIBUTE_BUILTINS and len(node.args) >= 2:
            name = node.args[1]
            if isinstance(name, ast.Constant) and isinstance(name.value, str):
                self._check_attribute_name(node, name.value)
            else:
                self._report(node, "PP6004", f"{func.id}() needs a literal attribute name",
                             f'Write the attribute directly, or {func.id}(obj, "name") with a literal.')
        self.generic_visit(node)
