"""Static name resolution across a project's modules and the SDK stubs.

Only module-level bindings are followed (imports, classes, functions, assignments), which
is exactly where declarations live. Anything that needs running code to know is
`Unknown`, and the caller turns that into a diagnostic instead of guessing.
"""

import ast
from dataclasses import dataclass

from parallax_transpiler.extract.sources import Module

# Standard-library modules game code may import. Their names are opaque
# builtins here: `typing.Literal`, `enum.Enum`, `math.pi`.
STDLIB_MODULES = frozenset({
    "math", "random", "dataclasses", "enum", "typing",
    "collections", "collections.abc", "__future__",
})

BUILTIN_NAMES = frozenset({
    "float", "int", "str", "bool", "list", "dict", "tuple", "set", "frozenset", "type",
    "object", "len", "range", "min", "max", "abs", "round", "sorted", "sum", "any", "all",
    "print", "isinstance", "enumerate", "zip", "reversed", "map", "filter", "staticmethod",
    "property", "classmethod", "super",
})


@dataclass(frozen=True)
class ModuleV:
    name: str


@dataclass(frozen=True)
class ClassV:
    module: str
    name: str


@dataclass(frozen=True)
class FuncV:
    module: str
    name: str


@dataclass(frozen=True)
class AssignV:
    """A module-level variable; `expr` is what it was assigned."""
    module: str
    name: str


@dataclass(frozen=True)
class BuiltinV:
    """A Python builtin or a stdlib name (`float`, `Literal`, `Enum`, `math.pi`)."""
    name: str


@dataclass(frozen=True)
class ProjectV:
    """A path into the generated `project` module: ("Prefabs", "ball")."""
    path: tuple[str, ...]


@dataclass(frozen=True)
class AttrV:
    """An attribute of a class: an action of an Actions set, an Enum member, an SDK constant."""
    owner: ClassV
    name: str


@dataclass(frozen=True)
class TagV:
    id: str
    module: str
    name: str


@dataclass(frozen=True)
class Unknown:
    reason: str


Value = ModuleV | ClassV | FuncV | AssignV | BuiltinV | ProjectV | AttrV | TagV | Unknown


@dataclass
class _Binding:
    kind: str  # "class" | "func" | "assign" | "import"
    node: ast.AST | None = None
    target_module: str | None = None
    target_name: str | None = None


def _resolve_relative(module: Module, level: int, name: str | None) -> str:
    parts = module.name.split(".")
    base = parts if module.package else parts[:-1]
    if level > 1:
        base = base[: len(base) - (level - 1)]
    return ".".join([*base, *([name] if name else [])])


def _index(module: Module) -> dict[str, _Binding]:
    index: dict[str, _Binding] = {}

    def visit(statements: list[ast.stmt]) -> None:
        for stmt in statements:
            if isinstance(stmt, ast.ClassDef):
                index[stmt.name] = _Binding("class", stmt)
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                index[stmt.name] = _Binding("func", stmt)
            elif isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    if isinstance(target, ast.Name):
                        index[target.id] = _Binding("assign", stmt.value)
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                index[stmt.target.id] = _Binding("assign", stmt.value)
            elif isinstance(stmt, ast.Import):
                for alias in stmt.names:
                    if alias.asname is not None:
                        index[alias.asname] = _Binding("import", target_module=alias.name)
                    else:
                        top = alias.name.split(".")[0]
                        index[top] = _Binding("import", target_module=top)
            elif isinstance(stmt, ast.ImportFrom):
                source = _resolve_relative(module, stmt.level, stmt.module) if stmt.level else (stmt.module or "")
                for alias in stmt.names:
                    if alias.name == "*":
                        continue
                    index[alias.asname or alias.name] = _Binding("import", target_module=source, target_name=alias.name)
            elif isinstance(stmt, ast.If):
                visit(stmt.body)
                visit(stmt.orelse)

    visit(module.tree.body)
    return index


class Resolver:
    def __init__(self, modules: dict[str, Module]) -> None:
        self.modules = modules
        self._indexes: dict[str, dict[str, _Binding]] = {}

    def index(self, module: str) -> dict[str, _Binding]:
        if module not in self._indexes:
            self._indexes[module] = _index(self.modules[module])
        return self._indexes[module]

    def class_node(self, cls: ClassV) -> ast.ClassDef:
        node = self.index(cls.module)[cls.name].node
        assert isinstance(node, ast.ClassDef)
        return node

    def func_node(self, fn: FuncV) -> ast.FunctionDef | ast.AsyncFunctionDef:
        node = self.index(fn.module)[fn.name].node
        assert isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        return node

    def assigned(self, var: AssignV) -> ast.expr:
        node = self.index(var.module)[var.name].node
        assert isinstance(node, ast.expr)
        return node

    def _module_member(self, module: str, name: str, seen: frozenset[tuple[str, str]]) -> Value:
        if f"{module}.{name}" in self.modules:
            return ModuleV(f"{module}.{name}")
        if module == "project":
            return ProjectV((name,))
        if module in STDLIB_MODULES or module.split(".")[0] in STDLIB_MODULES:
            return BuiltinV(name)
        if module in self.modules:
            return self.lookup(module, name, seen)
        return Unknown(f"module '{module}' is not part of the project or the SDK")

    def lookup(self, module: str, name: str, seen: frozenset[tuple[str, str]] = frozenset()) -> Value:
        """What `name` means at the top level of `module`."""
        if (module, name) in seen:
            return Unknown(f"'{name}' is imported in a cycle")
        seen = seen | {(module, name)}
        binding = self.index(module).get(name)
        if binding is None:
            if name in BUILTIN_NAMES:
                return BuiltinV(name)
            return Unknown(f"'{name}' is not defined in {module}")
        if binding.kind == "class":
            return ClassV(module, name)
        if binding.kind == "func":
            return FuncV(module, name)
        if binding.kind == "assign":
            return self._deref(AssignV(module, name), seen)
        assert binding.target_module is not None
        if binding.target_name is None:
            if binding.target_module == "project":
                return ModuleV("project")
            if binding.target_module in STDLIB_MODULES or binding.target_module in self.modules:
                return ModuleV(binding.target_module)
            return Unknown(f"module '{binding.target_module}' is not part of the project or the SDK")
        return self._module_member(binding.target_module, binding.target_name, seen)

    def _deref(self, var: AssignV, seen: frozenset[tuple[str, str]]) -> Value:
        """Aliases resolve through; `tag("x")` becomes a TagV; anything else stays a variable."""
        expr = self.assigned(var)
        if isinstance(expr, (ast.Name, ast.Attribute)):
            return self.resolve(var.module, expr, seen)
        if isinstance(expr, ast.Call) and expr.args and isinstance(expr.args[0], ast.Constant):
            fn = self.resolve(var.module, expr.func, seen)
            if fn == FuncV("parallax", "tag") and isinstance(expr.args[0].value, str):
                return TagV(expr.args[0].value, var.module, var.name)
        return var

    def resolve(self, module: str, expr: ast.expr, seen: frozenset[tuple[str, str]] = frozenset()) -> Value:
        if isinstance(expr, ast.Name):
            return self.lookup(module, expr.id, seen)
        if isinstance(expr, ast.Attribute):
            base = self.resolve(module, expr.value, seen)
            return self.member(base, expr.attr, seen)
        return Unknown(f"'{ast.unparse(expr)}' is not a name")

    def member(self, base: Value, attr: str, seen: frozenset[tuple[str, str]] = frozenset()) -> Value:
        if isinstance(base, ModuleV):
            if base.name == "project":
                return ProjectV((attr,))
            if base.name in STDLIB_MODULES:
                return BuiltinV(f"{base.name}.{attr}") if base.name not in ("typing", "enum", "collections.abc") else BuiltinV(attr)
            return self._module_member(base.name, attr, seen)
        if isinstance(base, ProjectV):
            return ProjectV((*base.path, attr))
        if isinstance(base, ClassV):
            return AttrV(base, attr)
        if isinstance(base, Unknown):
            return base
        return Unknown(f"can't read '.{attr}' statically")
