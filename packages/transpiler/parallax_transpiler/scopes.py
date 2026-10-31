"""Scope analysis: which binding every name refers to, with Python's rules.

  - A name assigned anywhere in a function is local to it (unless `global`/`nonlocal`).
  - Class bodies are a scope, but functions nested in them don't see it.
  - Comprehensions are their own scope; their first iterable belongs to the enclosing one.
  - A walrus inside a comprehension binds in the nearest enclosing function (or module).

The emitter declares each scope's locals at the top of the JS function (`let`), so JS
block scoping never changes which binding a name means.
"""

import ast
from dataclasses import dataclass, field

FUNCTION_KINDS = ("function", "lambda", "comprehension")


@dataclass
class Binding:
    """How a name is bound in a scope: every node that binds it."""
    nodes: list[ast.AST] = field(default_factory=list)

    @property
    def only_plain_defs(self) -> bool:
        """Bound exactly by undecorated `def`s (so a call to it is a plain JS call)."""
        return bool(self.nodes) and all(
            isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.decorator_list for n in self.nodes)

    @property
    def only_plain_class(self) -> ast.ClassDef | None:
        if len(self.nodes) == 1 and isinstance(self.nodes[0], ast.ClassDef) and not self.nodes[0].decorator_list:
            return self.nodes[0]
        return None

    @property
    def only_imports(self) -> bool:
        return bool(self.nodes) and all(isinstance(n, (ast.Import, ast.ImportFrom)) for n in self.nodes)


@dataclass
class Scope:
    kind: str  # module | class | function | lambda | comprehension
    node: ast.AST
    parent: "Scope | None"
    qualname: str = ""
    bindings: dict[str, Binding] = field(default_factory=dict)
    globals: set[str] = field(default_factory=set)
    nonlocals: set[str] = field(default_factory=set)
    params: list[str] = field(default_factory=list)

    def bind(self, name: str, node: ast.AST) -> None:
        self.bindings.setdefault(name, Binding()).nodes.append(node)

    def is_local(self, name: str) -> bool:
        return name in self.bindings and name not in self.globals and name not in self.nonlocals

    def module(self) -> "Scope":
        scope = self
        while scope.parent is not None:
            scope = scope.parent
        return scope

    def resolve(self, name: str) -> tuple[str, "Scope | None"]:
        """('local'|'class'|'free'|'global'|'builtin', scope that binds it)."""
        if self.kind == "module":
            return ("global", self) if name in self.bindings else ("builtin", None)
        if name in self.globals:
            return "global", self.module()
        if self.is_local(name):
            return ("class", self) if self.kind == "class" else ("local", self)
        scope = self.parent
        while scope is not None:
            if scope.kind == "module":
                return ("global", scope) if name in scope.bindings else ("builtin", None)
            if scope.kind != "class" and scope.is_local(name):
                return "free", scope
            if scope.kind != "class" and name in scope.globals:
                return "global", scope.module()
            scope = scope.parent
        return "builtin", None

    def binding(self, name: str) -> Binding | None:
        kind, scope = self.resolve(name)
        return scope.bindings.get(name) if scope is not None else None

    def locals_to_declare(self) -> list[str]:
        return [n for n in self.bindings if self.is_local(n) and n not in self.params]


class ScopeTable:
    """Every scope in a module, looked up by the node that opens it."""

    def __init__(self, tree: ast.Module) -> None:
        self.by_node: dict[int, Scope] = {}
        self.module = Scope("module", tree, None)
        self.by_node[id(tree)] = self.module
        _Collector(self, self.module).visit_body(tree.body)

    def of(self, node: ast.AST) -> Scope:
        return self.by_node[id(node)]


def _qual(parent: Scope, name: str) -> str:
    if parent.kind == "module":
        return name
    if parent.kind == "class":
        return f"{parent.qualname}.{name}"
    return f"{parent.qualname}.<locals>.{name}"


class _Collector(ast.NodeVisitor):
    """Collects the bindings of one scope; opens child scopes for nested definitions."""

    def __init__(self, table: ScopeTable, scope: Scope) -> None:
        self.table = table
        self.scope = scope

    def visit_body(self, body: list[ast.stmt]) -> None:
        for stmt in body:
            self.visit(stmt)

    def _open(self, kind: str, node: ast.AST, name: str) -> Scope:
        scope = Scope(kind, node, self.scope, _qual(self.scope, name))
        self.table.by_node[id(node)] = scope
        return scope

    # ── Definitions ─────────────────────────────────────────────────────────────

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for deco in node.decorator_list:
            self.visit(deco)
        self._visit_arg_defaults(node.args)
        self.scope.bind(node.name, node)
        scope = self._open("function", node, node.name)
        _bind_params(scope, node.args)
        _Collector(self.table, scope).visit_body(node.body)

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self._visit_arg_defaults(node.args)
        scope = self._open("lambda", node, "<lambda>")
        _bind_params(scope, node.args)
        _Collector(self.table, scope).visit(node.body)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for expr in [*node.decorator_list, *node.bases, *(k.value for k in node.keywords)]:
            self.visit(expr)
        self.scope.bind(node.name, node)
        scope = self._open("class", node, node.name)
        _Collector(self.table, scope).visit_body(node.body)

    def _visit_arg_defaults(self, args: ast.arguments) -> None:
        for d in [*args.defaults, *(d for d in args.kw_defaults if d is not None)]:
            self.visit(d)

    def _visit_comprehension(self, node: ast.ListComp | ast.SetComp | ast.GeneratorExp | ast.DictComp) -> None:
        generators = node.generators
        self.visit(generators[0].iter)
        scope = self._open("comprehension", node, "<comprehension>")
        inner = _Collector(self.table, scope)
        for i, gen in enumerate(generators):
            inner._bind_target(gen.target)
            if i > 0:
                inner.visit(gen.iter)
            for cond in gen.ifs:
                inner.visit(cond)
        if isinstance(node, ast.DictComp):
            inner.visit(node.key)
            inner.visit(node.value)
        else:
            inner.visit(node.elt)

    visit_ListComp = _visit_comprehension
    visit_SetComp = _visit_comprehension
    visit_GeneratorExp = _visit_comprehension
    visit_DictComp = _visit_comprehension

    # ── Bindings ────────────────────────────────────────────────────────────────

    def _bind_target(self, target: ast.AST) -> None:
        if isinstance(target, ast.Name):
            self.scope.bind(target.id, target)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._bind_target(elt)
        elif isinstance(target, ast.Starred):
            self._bind_target(target.value)
        else:
            self.visit(target)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.scope.bind(node.id, node)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        scope = self.scope
        while scope.kind == "comprehension":
            scope = scope.parent  # type: ignore[assignment]
        scope.bind(node.target.id, node)  # type: ignore[union-attr]
        if scope is not self.scope:
            self.scope.nonlocals.add(node.target.id) if scope.kind != "module" else self.scope.globals.add(node.target.id)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.scope.bind(alias.asname or alias.name.split(".")[0], node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name != "*":
                self.scope.bind(alias.asname or alias.name, node)

    def visit_Global(self, node: ast.Global) -> None:
        self.scope.globals.update(node.names)
        module = self.scope.module()
        for name in node.names:
            module.bindings.setdefault(name, Binding()).nodes.append(node)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.scope.nonlocals.update(node.names)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self.visit(node.type)
        if node.name:
            self.scope.bind(node.name, node)
        self.visit_body(node.body)

    def visit_For(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self._bind_target(node.target)
        self.visit_body(node.body)
        self.visit_body(node.orelse)

    visit_AsyncFor = visit_For

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        # The annotation is not evaluated in functions (compiled code drops it); class
        # annotations are compiled into thunks resolved by the emitter, not bindings.
        if node.value is not None:
            self.visit(node.value)
        if isinstance(node.target, ast.Name):
            if node.value is not None or self.scope.kind != "class":
                self.scope.bind(node.target.id, node.target)
        else:
            self.visit(node.target)

    def visit_arg(self, node: ast.arg) -> None:
        pass  # annotations on parameters are dropped


def _bind_params(scope: Scope, args: ast.arguments) -> None:
    for a in [*args.posonlyargs, *args.args]:
        scope.params.append(a.arg)
    if args.vararg:
        scope.params.append(args.vararg.arg)
    for a in args.kwonlyargs:
        scope.params.append(a.arg)
    if args.kwarg:
        scope.params.append(args.kwarg.arg)
    for name in scope.params:
        scope.bind(name, args)
