"""The static shape of what a panel's `state()` returns, for checking HTML bindings.

A shape is JSON:
  {"kind": "object", "keys": {name: shape}, "open": bool}   open = more keys may exist
  {"kind": "list", "item": shape}
  {"kind": "value"}                                           a scalar (number, text, bool)
  {"kind": "any"}                                             can't be known statically
The checker only reports what a shape proves; `any` and `open` never produce errors.
"""

import ast
from collections.abc import Callable

Shape = dict[str, object]

ANY: Shape = {"kind": "any"}
VALUE: Shape = {"kind": "value"}

SCALAR_CALLS = frozenset({"len", "str", "int", "float", "round", "bool", "abs", "sum", "min", "max", "format"})
LIST_CALLS = frozenset({"list", "sorted", "reversed", "tuple"})


def merge(a: Shape | None, b: Shape | None) -> Shape:
    if a is None:
        return b if b is not None else ANY
    if b is None:
        return a
    if a["kind"] == "any" or b["kind"] == "any":
        return ANY
    if a["kind"] != b["kind"]:
        return ANY
    if a["kind"] == "object":
        keys: dict[str, Shape] = dict(a["keys"])  # type: ignore[arg-type]
        for name, shape in b["keys"].items():  # type: ignore[attr-defined]
            keys[name] = merge(keys.get(name), shape)
        return {"kind": "object", "keys": keys, "open": bool(a["open"]) or bool(b["open"])}
    if a["kind"] == "list":
        return {"kind": "list", "item": merge(a["item"], b["item"])}  # type: ignore[arg-type]
    return VALUE


def _returns(body: list[ast.stmt]) -> list[ast.expr | None]:
    found: list[ast.expr | None] = []

    def visit(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                continue
            if isinstance(child, ast.Return):
                found.append(child.value)
            visit(child)

    for stmt in body:
        if isinstance(stmt, ast.Return):
            found.append(stmt.value)
        visit(stmt)
    return found


class _Locals:
    """What each local name was assigned, appended to, or iterated as."""

    def __init__(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.assigned: dict[str, list[ast.expr]] = {}
        self.appended: dict[str, list[ast.expr]] = {}
        self.opaque: set[str] = {a.arg for a in fn.args.args}
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    self._target(target, node.value)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and node.value is not None:
                self._target(node.target, node.value if isinstance(node, ast.AnnAssign) else None)
            elif isinstance(node, (ast.For, ast.comprehension)):
                for name in ast.walk(node.target):
                    if isinstance(name, ast.Name):
                        self.opaque.add(name.id)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                owner = node.func.value.id
                if node.func.attr == "append" and node.args:
                    self.appended.setdefault(owner, []).append(node.args[0])
                elif node.func.attr in ("extend", "update", "insert", "setdefault"):
                    self.opaque.add(owner)

    def _target(self, target: ast.expr, value: ast.expr | None) -> None:
        if isinstance(target, ast.Name):
            if value is None:
                self.opaque.add(target.id)
            else:
                self.assigned.setdefault(target.id, []).append(value)
        elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
            self.opaque.add(target.value.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                self._target(element, None)


FunctionLookup = Callable[[ast.expr], ast.FunctionDef | ast.AsyncFunctionDef | None]


class ShapeReader:
    def __init__(self, lookup: FunctionLookup) -> None:
        self._lookup = lookup
        self._active: set[int] = set()

    def function(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> Shape:
        if id(fn) in self._active:
            return ANY
        self._active.add(id(fn))
        try:
            local = _Locals(fn)
            shape: Shape | None = None
            for value in _returns(fn.body):
                shape = merge(shape, VALUE if value is None else self.expr(value, local, set()))
            return shape if shape is not None else VALUE
        finally:
            self._active.discard(id(fn))

    def expr(self, node: ast.expr, local: _Locals, names: set[str]) -> Shape:
        if isinstance(node, ast.Dict):
            keys: dict[str, Shape] = {}
            open_ = False
            for key, value in zip(node.keys, node.values):
                if key is None:
                    spread = self.expr(value, local, names)
                    if spread["kind"] == "object":
                        keys.update(spread["keys"])  # type: ignore[arg-type]
                        open_ = open_ or bool(spread["open"])
                    else:
                        open_ = True
                elif isinstance(key, ast.Constant) and isinstance(key.value, str):
                    keys[key.value] = self.expr(value, local, names)
                else:
                    open_ = True
            return {"kind": "object", "keys": keys, "open": open_}
        if isinstance(node, ast.DictComp):
            return {"kind": "object", "keys": {}, "open": True}
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            item: Shape | None = None
            for element in node.elts:
                item = merge(item, self.expr(element, local, names))
            return {"kind": "list", "item": item if item is not None else ANY}
        if isinstance(node, (ast.ListComp, ast.GeneratorExp, ast.SetComp)):
            return {"kind": "list", "item": self.expr(node.elt, local, names)}
        if isinstance(node, ast.IfExp):
            return merge(self.expr(node.body, local, names), self.expr(node.orelse, local, names))
        if isinstance(node, ast.BoolOp):
            shape: Shape | None = None
            for value in node.values:
                shape = merge(shape, self.expr(value, local, names))
            return shape if shape is not None else ANY
        if isinstance(node, (ast.Constant, ast.JoinedStr, ast.Compare, ast.BinOp)):
            return VALUE
        if isinstance(node, ast.UnaryOp):
            return VALUE
        if isinstance(node, ast.Name):
            return self._name(node.id, local, names)
        if isinstance(node, ast.Call):
            return self._call(node, local, names)
        return ANY

    def _name(self, name: str, local: _Locals, names: set[str]) -> Shape:
        if name in names or name in local.opaque or name not in local.assigned:
            return ANY
        names = names | {name}
        shape: Shape | None = None
        for value in local.assigned[name]:
            shape = merge(shape, self.expr(value, local, names))
        if name in local.appended and shape is not None and shape["kind"] == "list":
            item: Shape | None = None
            for value in local.appended[name]:
                item = merge(item, self.expr(value, local, names))
            existing = shape["item"]
            # `rows = []` contributes no item shape of its own.
            empty = all(isinstance(v, ast.List) and not v.elts for v in local.assigned[name])
            shape = {"kind": "list", "item": item if empty else merge(existing, item)}  # type: ignore[arg-type]
        return shape if shape is not None else ANY

    def _call(self, node: ast.Call, local: _Locals, names: set[str]) -> Shape:
        if isinstance(node.func, ast.Name):
            fn = node.func.id
            if fn in SCALAR_CALLS:
                return VALUE
            if fn in LIST_CALLS and len(node.args) == 1:
                inner = self.expr(node.args[0], local, names)
                return inner if inner["kind"] == "list" else {"kind": "list", "item": ANY}
            if fn == "dict" and not node.args:
                return {"kind": "object", "keys": {kw.arg: self.expr(kw.value, local, names) for kw in node.keywords if kw.arg},
                        "open": any(kw.arg is None for kw in node.keywords)}
        if isinstance(node.func, ast.Attribute) and node.func.attr in ("text", "join", "upper", "lower", "title", "format"):
            return VALUE
        target = self._lookup(node.func)
        if target is not None:
            return self.function(target)
        return ANY


def documented(doc: str | None) -> Shape | None:
    """The state shape a built-in panel's SDK docstring opens with — `{shown, icons: [{x, y}],
    a11y}` — closed (the keys are the contract); a bare key may hold anything. None when the
    docstring doesn't start with one."""
    text = (doc or "").lstrip()
    if not text.startswith("{"):
        return None
    pos = 0

    def skip() -> None:
        nonlocal pos
        while pos < len(text) and text[pos].isspace():
            pos += 1

    def shape() -> Shape | None:
        nonlocal pos
        skip()
        if text.startswith("[", pos):
            pos += 1
            item = shape()
            skip()
            if item is None or not text.startswith("]", pos):
                return None
            pos += 1
            return {"kind": "list", "item": item}
        if not text.startswith("{", pos):
            return None
        pos += 1
        keys: dict[str, Shape] = {}
        while True:
            skip()
            start = pos
            while pos < len(text) and (text[pos].isalnum() or text[pos] == "_"):
                pos += 1
            if pos == start:
                return None
            name = text[start:pos]
            skip()
            value: Shape | None = ANY
            if text.startswith(":", pos):
                pos += 1
                value = shape()
                if value is None:
                    return None
            keys[name] = value
            skip()
            if text.startswith(",", pos):
                pos += 1
                continue
            if text.startswith("}", pos):
                pos += 1
                return {"kind": "object", "keys": keys, "open": False}
            return None

    return shape()

