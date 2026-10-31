"""Emit pass: Parallax Python → one ES module per file (contract C1).

Every operation with Python semantics goes through the support module `pyrt`, imported
as `$rt` (Python identifiers can't contain `$`, so no compiled name collides with it or
with the temporaries `$t0`, signatures `$s0`, …). Rules this pass keeps:

  - Rejection, never approximation: an unsupported construct is a PP6xxx diagnostic with
    a rewrite, and a file with any diagnostic produces no module at all.
  - No unresolved name is ever emitted: a name Python can't bind is PP6010, so compiled
    code can't reach a JavaScript global.

Calling convention (shared with the api layer, `api/kwargs.ts`): keyword arguments travel
as ONE trailing `Kwargs` value — `f(a, b=1)` → `f(a, $rt.kw({"b": 1}))`; `**d` merges into
it; `*xs` spreads. A compiled `def` binds its arguments with CPython's rules
(`$rt.bind`), with a fast path when called with exactly its positional parameters.
"""

import ast
import json
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator

from parallax_transpiler import names as N
from parallax_transpiler.diagnostics import Diagnostic
from parallax_transpiler.project import (
    SDK_PACKAGES, SDK_RENAMED, SDK_SUBMODULES, ProjectIndex, absolute_module, relative_specifier, sdk_specifier,
)
from parallax_transpiler.scopes import Scope, ScopeTable
from parallax_transpiler.source_map import line_mark

RT = "$rt"
MAX_SAFE_INT = 2**53 - 1

FLOAT_MATH = frozenset({"sqrt", "exp", "log", "log2", "log10", "pow", "fabs", "sin", "cos", "tan",
                        "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "hypot", "degrees",
                        "radians", "copysign", "fmod", "dist", "pi", "tau", "e", "inf", "nan"})
FLOAT_RANDOM = frozenset({"random", "uniform", "gauss"})
STDLIB_CLASSES = frozenset({("enum", "Enum"), ("collections", "deque"), ("collections", "Counter"),
                            ("collections", "defaultdict"), ("typing", "NamedTuple"), ("typing", "Protocol")})

BINOPS = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul", ast.Div: "truediv", ast.FloorDiv: "floordiv",
          ast.Mod: "mod", ast.Pow: "pow", ast.LShift: "lshift", ast.RShift: "rshift",
          ast.BitAnd: "and_", ast.BitOr: "or_", ast.BitXor: "xor", ast.MatMult: "matmul"}
CMPOPS = {ast.Eq: "eq", ast.NotEq: "ne", ast.Lt: "lt", ast.LtE: "le", ast.Gt: "gt", ast.GtE: "ge"}


class CompileError(Exception):
    """Raised inside an expression to abandon it after a diagnostic was recorded."""


@dataclass
class Loop:
    broke: str | None  # flag set by `break` when the loop has an `else`


@dataclass
class FnCtx:
    """One JS function being emitted (or the module body)."""
    scope: Scope
    is_async: bool = False
    self_name: str | None = None      # the method's first parameter (bound to `this`)
    super_ok: bool = False            # directly inside a method: `super()` is allowed
    temps: list[str] = field(default_factory=list)
    loops: list[Loop] = field(default_factory=list)
    handlers: list[str] = field(default_factory=list)
    class_js: str | None = None       # set while emitting class-body expressions
    class_methods: frozenset[str] = frozenset()
    pre: list[str] = field(default_factory=list)  # statements hoisted to the function top


class ModuleEmitter:
    def __init__(self, source: str, path: str, index: ProjectIndex) -> None:
        self.source = source
        self.path = path
        self.index = index
        self.module_name = index.module_of(path)
        self.is_package = index.is_package_path(path)
        self.diagnostics: list[Diagnostic] = []
        self.import_lines: list[str] = []
        self.module_consts: list[str] = []
        self.import_specs: dict[str, str] = {}   # specifier → namespace alias
        self.counter = 0
        self.stdlib_aliases: dict[str, str] = {}  # local name → stdlib module (import math)
        self.stdlib_names: dict[str, tuple[str, str]] = {}  # local name → (module, member)
        self.import_names: set[str] = set()       # module-level names bound by a JS import
        self.named_imports: dict[str, list[str]] = {}  # specifier → `name [as local]`
        self.sdk_modules: dict[str, str] = {}     # local name → SDK submodule (from parallax import plugins)

    # ── Diagnostics ─────────────────────────────────────────────────────────────

    def error(self, node: ast.AST, code: str, message: str, fix: str) -> CompileError:
        self.diagnostics.append(Diagnostic(code=code, message=message, path=self.path,
                                           line=getattr(node, "lineno", 0),
                                           column=getattr(node, "col_offset", 0) + 1, fix=fix))
        return CompileError(message)

    def unsupported(self, node: ast.AST, what: str, fix: str, code: str = "PP6020") -> CompileError:
        return self.error(node, code, f"{what} is not supported in Parallax Python", fix)

    def fresh(self, prefix: str) -> str:
        self.counter += 1
        return f"${prefix}{self.counter}"

    def temp(self) -> str:
        name = self.fresh("t")
        self.ctx.temps.append(name)
        return name

    # ── Module ──────────────────────────────────────────────────────────────────

    def emit(self, tree: ast.Module) -> str:
        self.scopes = ScopeTable(tree)
        self.ctx = FnCtx(self.scopes.module)
        body = self.block(_skip_docstring(tree.body), top_level=True)
        module = self.scopes.module
        lets = [N.js_name(n) for n in module.bindings if n not in self.import_names]
        named = [f"import {{ {', '.join(names)} }} from '{spec}';" for spec, names in self.named_imports.items()]
        out = [f"import * as {RT} from 'parallax/__rt__';", *named, *self.import_lines, *self.module_consts]
        if lets:
            out.append(f"let {', '.join(lets)};")
        if self.ctx.temps:
            out.append(f"let {', '.join(self.ctx.temps)};")
        out.extend(self.ctx.pre)
        out.extend(body)
        exports = [_export_spec(n) for n in module.bindings]
        if exports:
            out.append(f"export {{ {', '.join(exports)} }};")
        return "\n".join(out) + "\n"

    # ── Statements ──────────────────────────────────────────────────────────────

    def block(self, stmts: list[ast.stmt], top_level: bool = False) -> list[str]:
        lines: list[str] = []
        for stmt in stmts:
            try:
                emitted = self.stmt(stmt, top_level)
                if emitted:
                    emitted[0] = line_mark(stmt.lineno) + emitted[0]
                lines.extend(emitted)
            except CompileError:
                lines.append("/* error */")
        return lines

    def indent(self, lines: list[str]) -> list[str]:
        return ["  " + line for line in lines]

    def stmt(self, node: ast.stmt, top_level: bool = False) -> list[str]:
        method = getattr(self, f"stmt_{type(node).__name__}", None)
        if method is None:
            raise self.unsupported(node, f"The '{type(node).__name__}' statement", _STATEMENT_FIX.get(
                type(node).__name__, "Rewrite this with if/for/while, functions and classes."))
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return method(node, top_level)
        return method(node)

    def stmt_Expr(self, node: ast.Expr) -> list[str]:
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return []  # a bare string is a comment
        if isinstance(node.value, ast.Constant) and node.value.value is Ellipsis:
            return []
        return [f"{self.expr(node.value)};"]

    def stmt_Pass(self, node: ast.Pass) -> list[str]:
        return []

    def stmt_Global(self, node: ast.Global) -> list[str]:
        return []

    def stmt_Nonlocal(self, node: ast.Nonlocal) -> list[str]:
        return []

    def stmt_Return(self, node: ast.Return) -> list[str]:
        if self.ctx.scope.kind == "module":
            raise self.unsupported(node, "'return' outside a function", "Remove it.")
        return [f"return {self.expr(node.value)};" if node.value is not None else "return;"]

    def stmt_Assign(self, node: ast.Assign) -> list[str]:
        if (len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and self.ctx.scope.kind == "module" and _is_type_alias(node.value, self)):
            return self.assign_name(node.targets[0].id, self.type_expr(node.value), node)
        value = self.expr(node.value)
        if len(node.targets) == 1 and (_is_simple(node.value) or not _needs_value_first(node.targets[0])):
            return self.assign(node.targets[0], value)
        tmp = self.temp()
        lines = [f"{tmp} = {value};"]
        for target in node.targets:
            lines.extend(self.assign(target, tmp))
        return lines

    def stmt_AnnAssign(self, node: ast.AnnAssign) -> list[str]:
        if node.value is None:
            return []
        if isinstance(node.target, ast.Name) and self.ctx.scope.kind == "module" and _is_type_alias(node.value, self):
            return self.assign_name(node.target.id, self.type_expr(node.value), node)
        return self.assign(node.target, self.expr(node.value))

    def stmt_AugAssign(self, node: ast.AugAssign) -> list[str]:
        op = BINOPS.get(type(node.op))
        if op is None:
            raise self.unsupported(node, "This augmented assignment", "Write it out: x = x <op> y.")
        fn = f"{RT}.i{op.rstrip('_')}"
        target = node.target
        if isinstance(target, ast.Name):
            current = self.name_load(target.id, target)
            return self.assign_name(target.id, f"{fn}({current}, {self.expr(node.value)})", target)
        if isinstance(target, ast.Attribute):
            obj = self.expr(target.value, receiver=True)
            if not _is_simple(target.value):
                tmp = self.temp()
                lines, obj = [f"{tmp} = {obj};"], tmp
            else:
                lines = []
            attr = self.attr_name(target)
            lines.append(f"{obj}.{attr} = {fn}({RT}.attr({obj}, {json.dumps(attr)}), {self.expr(node.value)});")
            return lines
        if isinstance(target, ast.Subscript):
            if isinstance(target.slice, ast.Slice):
                raise self.unsupported(node, "Augmented assignment to a slice", "Assign the slice explicitly.")
            obj, key = self.temp(), self.temp()
            return [f"{obj} = {self.expr(target.value, receiver=True)};", f"{key} = {self.expr(target.slice)};",
                    f"{RT}.setitem({obj}, {key}, {fn}({RT}.getitem({obj}, {key}), {self.expr(node.value)}));"]
        raise self.unsupported(node, "This augmented assignment target", "Assign to a name, attribute or item.")

    def stmt_If(self, node: ast.If) -> list[str]:
        lines = [f"if ({self.test(node.test)}) {{", *self.indent(self.block(node.body))]
        orelse = node.orelse
        while len(orelse) == 1 and isinstance(orelse[0], ast.If):
            elif_ = orelse[0]
            lines.append(f"{line_mark(elif_.lineno)}}} else if ({self.test(elif_.test)}) {{")
            lines.extend(self.indent(self.block(elif_.body)))
            orelse = elif_.orelse
        if orelse:
            lines.append("} else {")
            lines.extend(self.indent(self.block(orelse)))
        lines.append("}")
        return lines

    def stmt_While(self, node: ast.While) -> list[str]:
        loop = Loop(self.fresh("b") if node.orelse else None)
        test = "true" if isinstance(node.test, ast.Constant) and node.test.value is True else self.test(node.test)
        self.ctx.loops.append(loop)
        try:
            body = self.block(node.body)
        finally:
            self.ctx.loops.pop()
        lines = [f"while ({test}) {{", *self.indent(body), "}"]
        return self._loop_else(loop, lines, node.orelse)

    def stmt_For(self, node: ast.For) -> list[str]:
        loop = Loop(self.fresh("b") if node.orelse else None)
        iterable = f"{RT}.iterate({self.expr(node.iter)})"
        head, unpack = self.loop_target(node.target)
        self.ctx.loops.append(loop)
        try:
            body = self.block(node.body)
        finally:
            self.ctx.loops.pop()
        lines = [f"for ({head} of {iterable}) {{", *self.indent(unpack + body), "}"]
        return self._loop_else(loop, lines, node.orelse)

    def stmt_AsyncFor(self, node: ast.AsyncFor) -> list[str]:
        raise self.unsupported(node, "'async for'", "Use a plain for loop.")

    def _loop_else(self, loop: Loop, lines: list[str], orelse: list[ast.stmt]) -> list[str]:
        if loop.broke is None:
            return lines
        self.ctx.temps.append(loop.broke)
        return [f"{loop.broke} = false;", *lines, f"if (!{loop.broke}) {{", *self.indent(self.block(orelse)), "}"]

    def loop_target(self, target: ast.expr) -> tuple[str, list[str]]:
        if isinstance(target, ast.Name):
            return self.store_name(target.id, target), []
        tmp = self.temp()
        return tmp, self.assign(target, tmp)

    def stmt_Break(self, node: ast.Break) -> list[str]:
        loop = self.ctx.loops[-1] if self.ctx.loops else None
        if loop is not None and loop.broke is not None:
            return [f"{loop.broke} = true;", "break;"]
        return ["break;"]

    def stmt_Continue(self, node: ast.Continue) -> list[str]:
        return ["continue;"]

    def stmt_Raise(self, node: ast.Raise) -> list[str]:
        if node.exc is None:
            if not self.ctx.handlers:
                raise self.unsupported(node, "A bare 'raise' outside an except block",
                                       "Raise a specific exception: raise ValueError(...).")
            return [f"throw {self.ctx.handlers[-1]};"]
        exc = self.expr(node.exc)
        if node.cause is not None:
            return [f"throw {RT}.raise_from({exc}, {self.expr(node.cause)});"]
        return [f"throw {RT}.raise_({exc});"]

    def stmt_Assert(self, node: ast.Assert) -> list[str]:
        msg = self.expr(node.msg) if node.msg is not None else ""
        return [f"if (!({self.test(node.test)})) throw {RT}.assertion_error({msg});"]

    def stmt_Try(self, node: ast.Try) -> list[str]:
        ok = self.fresh("ok") if node.orelse else None
        body = self.block(node.body)
        if ok:
            self.ctx.temps.append(ok)
            body = [*body, f"{ok} = true;"]
        lines = ["try {", *self.indent(body)]
        if node.handlers:
            err = self.fresh("e")
            lines.append(f"}} catch ({err}) {{")
            lines.extend(self.indent(self.handlers(node.handlers, err)))
        if ok:
            lines.append("}")
            lines.extend([f"if ({ok}) {{", *self.indent(self.block(node.orelse)), "}"])
            if node.finalbody:
                lines = ["try {", *self.indent(lines), "} finally {", *self.indent(self.block(node.finalbody)), "}"]
            return [f"{ok} = false;", *lines]
        if node.finalbody:
            lines.extend(["} finally {", *self.indent(self.block(node.finalbody))])
        lines.append("}")
        return lines

    def handlers(self, handlers: list[ast.ExceptHandler], err: str) -> list[str]:
        chain: list[str] = [f"{err} = {RT}.exception_of({err});"]
        self.ctx.handlers.append(err)
        try:
            for i, handler in enumerate(handlers):
                body: list[str] = []
                if handler.name:
                    body.append(f"{self.store_name(handler.name, handler)} = {err};")
                body.extend(self.block(handler.body))
                if handler.type is None:
                    chain.append("{" if i == 0 else "} else {")
                    chain.extend(self.indent(body))
                    chain.append("}")
                    return chain
                cond = f"{RT}.exception_matches({err}, {self.expr(handler.type)})"
                chain.append(f"{'if' if i == 0 else '} else if'} ({cond}) {{")
                chain.extend(self.indent(body))
            chain.extend(["} else {", f"  throw {err};", "}"])
            return chain
        finally:
            self.ctx.handlers.pop()

    def stmt_TryStar(self, node: ast.AST) -> list[str]:
        raise self.unsupported(node, "'except*'", "Use a plain try/except.")

    def stmt_Delete(self, node: ast.Delete) -> list[str]:
        lines = []
        for target in node.targets:
            if isinstance(target, ast.Subscript) and not isinstance(target.slice, ast.Slice):
                lines.append(f"{RT}.delitem({self.expr(target.value, receiver=True)}, {self.expr(target.slice)});")
            elif isinstance(target, ast.Attribute):
                lines.append(f"{RT}.delattr({self.expr(target.value, receiver=True)}, {json.dumps(self.attr_name(target))});")
            else:
                raise self.unsupported(target, "Deleting a name or slice", "Assign None, or rebuild the list.")
        return lines

    def stmt_With(self, node: ast.With) -> list[str]:
        raise self.unsupported(node, "The 'with' statement", "Call the setup and cleanup explicitly (try/finally).")

    def stmt_Match(self, node: ast.AST) -> list[str]:
        raise self.unsupported(node, "The 'match' statement", "Use if/elif chains.")

    # ── Imports ─────────────────────────────────────────────────────────────────

    def stmt_Import(self, node: ast.Import, top_level: bool) -> list[str]:
        lines = []
        for alias in node.names:
            if alias.name in N.STDLIB:
                local = alias.asname or alias.name
                if "." in alias.name and alias.asname is None:
                    raise self.unsupported(node, f"'import {alias.name}'", f"Use 'from {alias.name} import ...'.",
                                           code="PP6013")
                self.stdlib_aliases[local] = alias.name
                lines.extend(self.assign_name(local, f"{RT}.{_stdlib_module_js(alias.name)}", node))
                continue
            raise self.unsupported(node, f"'import {alias.name}'",
                                   f"Import names instead: from {alias.name} import <name>.", code="PP6013")
        return lines

    def stmt_ImportFrom(self, node: ast.ImportFrom, top_level: bool) -> list[str]:
        if any(a.name == "*" for a in node.names):
            raise self.unsupported(node, "'import *'", "Import each name you use.", code="PP6013")
        module = absolute_module(self.module_name, self.is_package, node.level, node.module)
        if module is None:
            raise self.unsupported(node, "A relative import above the project root", "Import from the project root.",
                                   code="PP6013")
        if module == "__future__":
            raise self.unsupported(node, "'from __future__ import'", "Remove it; annotations are always lazy.",
                                   code="PP6013")
        if module in N.STDLIB:
            return self._import_stdlib(node, module)
        root = module.split(".")[0]
        lines: list[str] = []
        at_module_top = top_level and self.ctx.scope.kind == "module"
        if root in SDK_PACKAGES:
            spec = sdk_specifier(module)
            for alias in node.names:
                local = alias.asname or alias.name
                self.check_renamed(node, module, alias.name)
                if module == "parallax" and alias.name in SDK_SUBMODULES:
                    if at_module_top:
                        self.sdk_modules[local] = f"parallax.{alias.name}"
                    lines.extend(self._import_namespace(node, f"parallax/{alias.name}", local, at_module_top))
                else:
                    lines.extend(self._import_name(node, spec, alias.name, local, at_module_top))
            return lines
        if not self.index.exists(module):
            raise self.error(node, "PP6013", f"Module '{module}' is not in the project",
                             "Check the module path; project modules live under the project's packages.")
        for alias in node.names:
            local = alias.asname or alias.name
            submodule = f"{module}.{alias.name}"
            if submodule in self.index.modules and alias.name not in self.index.init_bindings.get(module, ()):
                spec = relative_specifier(self.path, self.index.modules[submodule])
                lines.extend(self._import_namespace(node, spec, local, at_module_top))
            elif module in self.index.modules:
                spec = relative_specifier(self.path, self.index.modules[module])
                lines.extend(self._import_name(node, spec, alias.name, local, at_module_top))
            else:
                raise self.error(node, "PP6013", f"'{alias.name}' is not a module of package '{module}'",
                                 f"Import it from the module that defines it, e.g. from {module}.<module> import {alias.name}.")
        return lines

    def _import_stdlib(self, node: ast.ImportFrom, module: str) -> list[str]:
        members = N.STDLIB[module]
        lines = []
        for alias in node.names:
            if alias.name not in members:
                available = ", ".join(sorted(members)) or "(nothing yet)"
                raise self.error(node, "PP6012", f"'{module}.{alias.name}' is not available in Parallax Python",
                                 f"Available from {module}: {available}.")
            local = alias.asname or alias.name
            target = members[alias.name]
            self.stdlib_names[local] = (module if module != "collections.abc" else "typing",
                                        target.split(".", 1)[1])
            lines.extend(self.assign_name(local, f"{RT}.{target}", node))
        return lines

    def _bound_once_by_import(self, local: str) -> bool:
        binding = self.scopes.module.bindings.get(local)
        return binding is not None and len(binding.nodes) == 1 and binding.only_imports

    def _import_name(self, node: ast.AST, spec: str, name: str, local: str, at_module_top: bool) -> list[str]:
        if at_module_top and self._bound_once_by_import(local):
            self.import_names.add(local)
            js = N.js_name(local)
            self.named_imports.setdefault(spec, []).append(name if js == name else f"{name} as {js}")
            return []
        ns = self._namespace(spec)
        return self.assign_name(local, f"{ns}[{json.dumps(name)}]", node)

    def _import_namespace(self, node: ast.AST, spec: str, local: str, at_module_top: bool) -> list[str]:
        if at_module_top and self._bound_once_by_import(local):
            self.import_names.add(local)
            self.import_lines.append(f"import * as {N.js_name(local)} from '{spec}';")
            return []
        return self.assign_name(local, self._namespace(spec), node)

    def _namespace(self, spec: str) -> str:
        if spec not in self.import_specs:
            alias = self.fresh("m")
            self.import_specs[spec] = alias
            self.import_lines.append(f"import * as {alias} from '{spec}';")
        return self.import_specs[spec]

    # ── Functions ───────────────────────────────────────────────────────────────

    def stmt_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
        ann = self.fn_annotations(node, skip_first=False)
        pre, fn = self.function_expr(node, method=False)
        if isinstance(node, ast.AsyncFunctionDef):
            fn = f"{RT}.async_fn({fn})"
        # The signature rides along (`__sig__`): panel actions read which parameters have defaults.
        fn = f"{RT}.pyfn({fn}, () => {self.last_sig})"
        if ann:
            fn = f"{RT}.fn_annotations({fn}, {ann})"
        for deco in reversed(node.decorator_list):
            fn = f"{self.call_value(deco)}({fn})"
        return [*pre, *self.assign_name(node.name, fn, node)]

    stmt_AsyncFunctionDef = stmt_FunctionDef

    def function_expr(self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda, method: bool,
                      kind: str = "function") -> tuple[list[str], str]:
        """(statements to run first, the JS function expression). `kind` is 'function',
        'method', 'getter', 'setter', 'static' or 'classmethod' (methods return a member)."""
        scope = self.scopes.of(node)
        is_async = isinstance(node, ast.AsyncFunctionDef)
        if any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in _walk_own(node)):
            raise self.unsupported(node, "A generator function (yield)",
                                   "Build and return a list; for a sequence over time use an async task.")
        args = node.args
        takes_self = kind in ("method", "getter", "setter", "classmethod")
        positional = [*args.posonlyargs, *args.args]
        self_name = None
        if takes_self:
            if not positional:
                raise self.unsupported(node, "A method without a 'self' parameter",
                                       "Add self as the first parameter, or decorate it with @staticmethod.",
                                       code="PP6030")
            self_name = positional[0].arg
        sig_pre, sig, params, binder = self.signature(node, scope, skip_first=takes_self, method=takes_self)
        self.last_sig = sig
        outer = self.ctx
        self.ctx = FnCtx(scope, is_async=is_async, self_name=self_name,
                         super_ok=kind in ("method", "getter", "setter", "classmethod"))
        try:
            if isinstance(node, ast.Lambda):
                body = [f"return {self.expr(node.body)};"]
            else:
                body = self.block(_skip_docstring(node.body))
            ctx = self.ctx
        finally:
            self.ctx = outer
        head: list[str] = []
        if self_name is not None:
            head.append(f"const {N.js_name(self_name)} = this;")
        head.extend(binder)
        declared = set(scope.params) | ({self_name} if self_name else set())
        local_names = [N.js_name(n) for n in scope.locals_to_declare() if n not in declared]
        if local_names or ctx.temps:
            head.append(f"let {', '.join([*local_names, *ctx.temps])};")
        head.extend(ctx.pre)
        star = "*" if is_async else ""
        lines = self.indent(head + body)
        params_js = ", ".join(params)
        mark = line_mark(node.lineno)
        if kind == "function":
            text = "\n".join([f"{mark}function{star} ({params_js}) {{", *lines, "}"])
            return sig_pre, text
        name = node.name  # type: ignore[union-attr]
        prefix = {"getter": "get ", "setter": "set ", "static": "static ", "classmethod": "static "}.get(kind, "")
        text = "\n".join([f"{mark}{prefix}{star}{name}({params_js}) {{", *lines, "}"])
        return sig_pre, text

    def fn_annotations(self, node: ast.FunctionDef | ast.AsyncFunctionDef, skip_first: bool) -> str | None:
        """`{ "x": () => <type> }` for the annotated parameters, in order (the api reads
        them, e.g. for panel actions). Evaluated lazily, like Python 3.14 annotations.
        The return annotation is left out: only parameters are read by the api."""
        args = node.args
        params = [*args.posonlyargs, *args.args]
        if skip_first:
            params = params[1:]
        params += [*([args.vararg] if args.vararg else []), *args.kwonlyargs, *([args.kwarg] if args.kwarg else [])]
        items = [f"{json.dumps(a.arg)}: () => {self.type_expr(a.annotation)}" for a in params if a.annotation is not None]
        return f"{{ {', '.join(items)} }}" if items else None

    def signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda, scope: Scope,
                  skip_first: bool, method: bool) -> tuple[list[str], str, list[str], list[str]]:
        """(statements creating the signature, its JS name, JS params, binder lines)."""
        args = node.args
        posonly = [a.arg for a in args.posonlyargs]
        positional = [*posonly, *(a.arg for a in args.args)]
        defaults = list(args.defaults)
        n_posonly = len(posonly)
        if skip_first:
            positional = positional[1:]
            n_posonly = max(0, n_posonly - 1)
            if len(defaults) > len(positional):
                defaults = defaults[1:]
        kwonly = [a.arg for a in args.kwonlyargs]
        kw_defaults = list(args.kw_defaults)
        qualname = scope.qualname if not isinstance(node, ast.Lambda) else "<lambda>"
        has_defaults = bool(defaults) or any(d is not None for d in kw_defaults)
        sig_name = self.fresh("s")
        defaults_js = f"[{', '.join(self.expr(d) for d in defaults)}]"
        kwd_js = f"[{', '.join(self.expr(d) if d is not None else f'{RT}.NO_DEFAULT' for d in kw_defaults)}]"
        sig = (f"{RT}.sig({json.dumps(qualname)}, {json.dumps(positional)}, {n_posonly}, {defaults_js}, "
               f"{json.dumps(kwonly)}, {kwd_js}, {json.dumps(args.vararg.arg if args.vararg else None)}, "
               f"{json.dumps(args.kwarg.arg if args.kwarg else None)}, {'true' if method else 'false'})")
        pre: list[str] = []
        if has_defaults:
            pre.append(f"const {sig_name} = {sig};")
        else:
            self.module_consts.append(f"const {sig_name} = {sig};")
        all_params = [*positional, *([args.vararg.arg] if args.vararg else []), *kwonly,
                      *([args.kwarg.arg] if args.kwarg else [])]
        js_params = [N.js_name(p) for p in all_params]
        if args.vararg or args.kwarg or kwonly:
            return pre, sig_name, [], [f"let [{', '.join(js_params)}] = {RT}.bind({sig_name}, arguments);"]
        n = len(positional)
        if n == 0:
            check = "arguments.length !== 0"
            return pre, sig_name, [], [f"if ({check}) {RT}.bind({sig_name}, arguments);"]
        check = f"arguments.length !== {n} || arguments[{n - 1}] instanceof {RT}.Kwargs"
        return pre, sig_name, js_params, [f"if ({check}) [{', '.join(js_params)}] = {RT}.bind({sig_name}, arguments);"]

    # ── Classes ─────────────────────────────────────────────────────────────────

    def stmt_ClassDef(self, node: ast.ClassDef) -> list[str]:
        scope = self.scopes.of(node)
        if node.keywords:
            raise self.unsupported(node, "Class keywords (metaclass=...)", "Remove them.", code="PP6030")
        if len(node.bases) > 1:
            raise self.unsupported(node, "Multiple inheritance", "Inherit from one class; share code with functions.",
                                   code="PP6030")
        if self.ctx.scope.kind == "class":
            raise self.unsupported(node, "A class nested in a class body", "Define it at module level.", code="PP6030")
        base_node = node.bases[0] if node.bases else None
        ref = self.static_ref(base_node) if base_node is not None else None
        is_enum = ref == ("stdlib", "enum", "Enum")
        if base_node is None or ref == ("builtin", "object"):
            base = f"{RT}.object"
        else:
            if isinstance(base_node, ast.Subscript):
                raise self.unsupported(base_node, "A generic base class", "Inherit from the plain class.", code="PP6030")
            base = self.expr(base_node)
        cls = self.class_binding_js(node)
        methods: list[str] = []
        after: list[str] = []
        annotations: list[tuple[str, str]] = []
        defined = {s.name for s in node.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))}
        outer = self.ctx
        self.ctx = FnCtx(scope, temps=outer.temps, class_js=cls, class_methods=frozenset(defined),
                         pre=outer.pre, loops=[], handlers=[])
        try:
            for stmt in _skip_docstring(node.body):
                try:
                    first = len(after)
                    self.class_stmt(stmt, cls, methods, after, annotations, is_enum)
                    if len(after) > first:
                        after[first] = line_mark(stmt.lineno) + after[first]
                except CompileError:
                    pass
        finally:
            self.ctx = outer
        header = f"{cls} = class extends {base} {{"
        lines = [header, *self.indent("\n".join(methods).split("\n") if methods else []), "};"]
        lines.append(f"{line_mark(node.lineno)}{RT}.class_info({cls}, {json.dumps(scope.qualname)});")
        ann = ", ".join(f"{json.dumps(name)}: () => {thunk}" for name, thunk in annotations)
        lines.append(f"{cls}.__annotations__ = {{ {ann} }};" if ann else f"{cls}.__annotations__ = {{}};")
        lines.extend(after)
        tail: list[str] = []  # the class statement's own again
        if "__eq__" in defined and "__hash__" not in defined:
            tail.append(f"{RT}.no_hash({cls});")
        if is_enum:
            tail.append(f"{cls} = {RT}.enum_class({cls});")
        elif base_node is not None:
            tail.append(f"{RT}.init_subclass({cls});")
        if tail:
            tail[0] = line_mark(node.lineno) + tail[0]
        lines.extend(tail)
        for deco in reversed(node.decorator_list):
            lines.append(f"{line_mark(deco.lineno)}{cls} = {self.call_value(deco)}({cls});")
        return lines

    def class_binding_js(self, node: ast.ClassDef) -> str:
        return self.store_name(node.name, node)

    def class_stmt(self, stmt: ast.stmt, cls: str, methods: list[str], after: list[str],
                   annotations: list[tuple[str, str]], is_enum: bool) -> None:
        if isinstance(stmt, ast.Pass) or (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant)):
            return
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.class_method(stmt, cls, methods, after)
            return
        if isinstance(stmt, ast.AnnAssign):
            if not isinstance(stmt.target, ast.Name):
                raise self.unsupported(stmt, "This class attribute target", "Annotate a plain name.", code="PP6030")
            if is_enum:
                raise self.unsupported(stmt, "An annotated Enum member", "Write members as NAME = \"value\".",
                                       code="PP6032")
            annotations.append((stmt.target.id, self.type_expr(stmt.annotation)))
            if stmt.value is not None:
                after.append(f"{RT}.class_attr({cls}, {json.dumps(stmt.target.id)}, {self.expr(stmt.value)});")
            return
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if not isinstance(target, ast.Name):
                    raise self.unsupported(stmt, "Unpacking in a class body", "Assign each attribute on its own line.",
                                           code="PP6030")
            if is_enum and not (isinstance(stmt.value, ast.Constant) and type(stmt.value.value) in (str, int)):
                raise self.error(stmt, "PP6032", "Enum members must be str or int literals",
                                 'Write members as NAME = "value"; compute other data in a method or property.')
            value = self.expr(stmt.value)
            for target in stmt.targets:
                after.append(f"{RT}.class_attr({cls}, {json.dumps(target.id)}, {value});")  # type: ignore[union-attr]
            return
        raise self.unsupported(stmt, f"A '{type(stmt).__name__}' statement in a class body",
                               "Class bodies hold methods, annotated fields and constants.", code="PP6030")

    def class_method(self, node: ast.FunctionDef | ast.AsyncFunctionDef, cls: str, methods: list[str],
                     after: list[str]) -> None:
        if node.name in ("constructor", "prototype", "__proto__"):
            raise self.error(node, "PP6003", f"A method named '{node.name}' is not allowed",
                             "Rename it; this name reaches JavaScript internals.")
        kind = "method"
        rest: list[ast.expr] = []
        for deco in node.decorator_list:
            ref = self.static_ref(deco)
            if ref == ("builtin", "property"):
                kind = "getter"
            elif ref == ("builtin", "staticmethod"):
                kind = "static"
            elif ref == ("builtin", "classmethod"):
                kind = "classmethod"
            elif isinstance(deco, ast.Attribute) and deco.attr == "setter" and isinstance(deco.value, ast.Name) \
                    and deco.value.id == node.name:
                kind = "setter"
            elif isinstance(deco, ast.Attribute) and deco.attr in ("getter", "deleter"):
                raise self.unsupported(deco, f"@property.{deco.attr}", "Use @property and @<name>.setter.", code="PP6030")
            else:
                rest.append(deco)
        if node.name == "__init_subclass__" and kind == "method":
            kind = "classmethod"  # implicitly a classmethod, as in Python
        if kind != "method" and rest:
            raise self.unsupported(node, "Combining @property/@staticmethod/@classmethod with other decorators",
                                   "Keep one of them.", code="PP6030")
        if kind in ("getter", "setter") and isinstance(node, ast.AsyncFunctionDef):
            raise self.unsupported(node, "An async property", "Make it a method.", code="PP6030")
        ann = self.fn_annotations(node, skip_first=kind not in ("static",)) if kind not in ("getter", "setter") else None
        pre, text = self.function_expr(node, method=True, kind=kind)
        after.extend(pre)
        methods.append(text)
        member = f"{cls}.prototype.{node.name}" if kind not in ("static", "classmethod") else f"{cls}.{node.name}"
        if ann:
            after.append(f"{RT}.fn_annotations({member}, {ann});")
        if isinstance(node, ast.AsyncFunctionDef):
            after.append(f"{RT}.mark_async({member});")
        if kind == "static":
            after.append(f"{RT}.static_method({cls}, {json.dumps(node.name)});")
        elif kind == "classmethod":
            after.append(f"{RT}.class_method({cls}, {json.dumps(node.name)});")
        if rest:
            decos = ", ".join(self.call_value(deco) for deco in rest)
            after.append(f"{RT}.decorate_method({cls}, {json.dumps(node.name)}, [{decos}]);")

    # ── Assignment ──────────────────────────────────────────────────────────────

    def assign(self, target: ast.expr, value: str) -> list[str]:
        if isinstance(target, ast.Name):
            return self.assign_name(target.id, value, target)
        if isinstance(target, ast.Attribute):
            if isinstance(target.value, ast.Call) and _is_super_call(target.value):
                raise self.unsupported(target, "Assigning through super()", "Assign on self.", code="PP6030")
            return [f"{self.expr(target.value, receiver=True)}.{self.attr_name(target)} = {value};"]
        if isinstance(target, ast.Subscript):
            obj = self.expr(target.value, receiver=True)
            if isinstance(target.slice, ast.Slice):
                lo, hi, step = self.slice_parts(target.slice)
                return [f"{RT}.setslice({obj}, {lo}, {hi}, {step}, {value});"]
            return [f"{RT}.setitem({obj}, {self.expr(target.slice)}, {value});"]
        if isinstance(target, (ast.Tuple, ast.List)):
            stars = [i for i, e in enumerate(target.elts) if isinstance(e, ast.Starred)]
            tmp = self.temp()
            if len(stars) > 1:
                raise self.unsupported(target, "Two starred targets", "Use one *rest target.")
            if stars:
                i = stars[0]
                lines = [f"{tmp} = {RT}.unpack_star({value}, {i}, {len(target.elts) - i - 1});"]
            else:
                lines = [f"{tmp} = {RT}.unpack({value}, {len(target.elts)});"]
            for i, elt in enumerate(target.elts):
                inner = elt.value if isinstance(elt, ast.Starred) else elt
                lines.extend(self.assign(inner, f"{tmp}[{i}]"))
            return lines
        raise self.unsupported(target, "This assignment target", "Assign to a name, attribute, item or tuple.")

    def assign_name(self, name: str, value: str, node: ast.AST) -> list[str]:
        if self.ctx.class_js is not None:
            raise self.unsupported(node, "This statement in a class body", "Move it out of the class body.",
                                   code="PP6030")
        return [f"{self.store_name(name, node)} = {value};"]

    def store_name(self, name: str, node: ast.AST) -> str:
        if name in self.import_names and self.ctx.scope.kind == "module":
            raise self.unsupported(node, f"Rebinding the imported name '{name}'", "Use a different name.")
        return N.js_name(name)

    # ── Expressions ─────────────────────────────────────────────────────────────

    def expr(self, node: ast.expr, receiver: bool = False) -> str:
        method = getattr(self, f"expr_{type(node).__name__}", None)
        if method is None:
            raise self.unsupported(node, f"The expression '{type(node).__name__}'",
                                   _EXPRESSION_FIX.get(type(node).__name__, "Rewrite it with supported expressions."),
                                   code="PP6021")
        if isinstance(node, (ast.Attribute, ast.Subscript, ast.Name)):
            return method(node, receiver)
        return method(node)

    def test(self, node: ast.expr) -> str:
        """A JS boolean expression for Python truthiness of `node`."""
        if self.is_bool(node):
            if isinstance(node, ast.BoolOp):
                op = " && " if isinstance(node.op, ast.And) else " || "
                return "(" + op.join(self.test(v) for v in node.values) + ")"
            if isinstance(node, ast.UnaryOp):
                return f"!{self.test(node.operand)}"
            return self.expr(node)
        if isinstance(node, ast.BoolOp):
            op = " && " if isinstance(node.op, ast.And) else " || "
            return "(" + op.join(self.test(v) for v in node.values) + ")"
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return f"!{self.test(node.operand)}"
        return f"{RT}.truthy({self.expr(node)})"

    def is_bool(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Compare):
            return True
        if isinstance(node, ast.Constant):
            return isinstance(node.value, bool)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return True
        if isinstance(node, ast.BoolOp):
            return all(self.is_bool(v) for v in node.values)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in N.BOOL_BUILTINS:
            return self.ctx.scope.resolve(node.func.id)[0] == "builtin"
        return False

    def is_float(self, node: ast.expr) -> bool:
        """Statically known to be a Python float (so integral values print as `3.0`)."""
        if isinstance(node, ast.Constant):
            return type(node.value) is float
        if isinstance(node, ast.BinOp):
            if isinstance(node.op, ast.Div):
                return True
            if isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Mod, ast.FloorDiv)):
                return (self.is_float(node.left) and self.is_number(node.right)) or \
                       (self.is_float(node.right) and self.is_number(node.left))
            return False
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return self.is_float(node.operand)
        if isinstance(node, ast.Call):
            ref = self.static_ref(node.func)
            if ref == ("builtin", "float"):
                return True
            if ref == ("builtin", "round") and len(node.args) == 2:
                return self.is_float(node.args[0])
            if ref == ("builtin", "abs") and len(node.args) == 1:
                return self.is_float(node.args[0])
            if ref is not None and ref[0] == "stdlib":
                return (ref[1] == "math" and ref[2] in FLOAT_MATH) or (ref[1] == "random" and ref[2] in FLOAT_RANDOM)
            return False
        if isinstance(node, (ast.Attribute, ast.Name)):
            ref = self.static_ref(node)
            return ref is not None and ref[0] == "stdlib" and ref[1] == "math" and ref[2] in ("pi", "tau", "e", "inf", "nan")
        return False

    def is_number(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Constant):
            return type(node.value) in (int, float)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return self.is_number(node.operand)
        if isinstance(node, ast.Call):
            ref = self.static_ref(node.func)
            return ref in (("builtin", "len"), ("builtin", "int"), ("builtin", "float"), ("builtin", "round"))
        return self.is_float(node) or (isinstance(node, ast.BinOp) and self.is_number(node.left) and self.is_number(node.right))

    def expr_Constant(self, node: ast.Constant) -> str:
        v = node.value
        if v is None:
            return "null"
        if v is True:
            return "true"
        if v is False:
            return "false"
        if v is Ellipsis:
            return f"{RT}.Ellipsis"
        if isinstance(v, str):
            return json.dumps(v)
        if isinstance(v, int):
            if abs(v) > MAX_SAFE_INT:
                raise self.error(node, "PP6022", f"The integer {v} is outside the exact range (±2**53)",
                                 "Parallax ints are exact up to 2**53; use a float for larger magnitudes.")
            return str(v)
        if isinstance(v, float):
            if v != v:
                return f"{RT}.math.nan"
            if v in (float("inf"), float("-inf")):
                return f"{RT}.math.inf" if v > 0 else f"(-{RT}.math.inf)"
            return repr(v)
        if isinstance(v, bytes):
            raise self.unsupported(node, "A bytes literal", "Use a str.", code="PP6021")
        raise self.unsupported(node, f"A {type(v).__name__} literal", "Use int, float or str.", code="PP6021")

    def expr_JoinedStr(self, node: ast.JoinedStr) -> str:
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(json.dumps(value.value))
            else:
                parts.append(self.formatted(value))  # type: ignore[arg-type]
        if not parts:
            return '""'
        if len(parts) == 1 and not parts[0].startswith('"'):
            return parts[0]
        return "(" + " + ".join(parts if parts[0].startswith('"') else ['""', *parts]) + ")"

    def formatted(self, node: ast.FormattedValue) -> str:
        value = self.expr(node.value)
        spec = self.expr(node.format_spec) if node.format_spec is not None else '""'
        if node.conversion == ord("r"):
            return f"{RT}.format({RT}.repr({value}), {spec})"
        if node.conversion == ord("s"):
            return f"{RT}.format({RT}.str({value}), {spec})"
        if node.conversion == ord("a"):
            raise self.unsupported(node, "The !a conversion", "Use !r.", code="PP6021")
        fn = "format_float" if self.is_float(node.value) else "format"
        return f"{RT}.{fn}({value}, {spec})"

    def expr_Name(self, node: ast.Name, receiver: bool = False) -> str:
        return self.name_load(node.id, node)

    def name_load(self, name: str, node: ast.AST) -> str:
        scope = self.ctx.scope
        kind, owner = scope.resolve(name)
        if kind == "class":
            if name in self.ctx.class_methods:
                return f"{self.ctx.class_js}.prototype.{name}"
            return f"{self.ctx.class_js}.{name}"
        if kind in ("local", "free", "global"):
            return N.js_name(name)
        if name in N.BUILTINS:
            return f"{RT}.{N.BUILTINS[name]}"
        if name in N.DECORATOR_BUILTINS:
            raise self.unsupported(node, f"'{name}' outside a decorator", f"Use @{name} on a method.", code="PP6011")
        if name in N.UNSUPPORTED_BUILTINS:
            raise self.error(node, "PP6011", f"'{name}' is not available in Parallax Python", N.UNSUPPORTED_BUILTINS[name])
        if name in ("True", "False", "None"):
            return {"True": "true", "False": "false", "None": "null"}[name]
        raise self.error(node, "PP6010", f"Name '{name}' is not defined",
                         "Define or import it; game code only sees its own names, imports and Python builtins.")

    def static_ref(self, node: ast.expr | None) -> tuple[str, ...] | None:
        """What a name or `module.member` statically refers to, when known:
        ('builtin', name) or ('stdlib', module, member)."""
        if isinstance(node, ast.Name):
            kind, owner = self.ctx.scope.resolve(node.id)
            if kind == "builtin":
                if node.id in N.BUILTINS or node.id in N.DECORATOR_BUILTINS:
                    return ("builtin", node.id)
                return None
            if kind == "global" and node.id in self.stdlib_names:
                return ("stdlib", *self.stdlib_names[node.id])
            return None
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            kind, owner = self.ctx.scope.resolve(node.value.id)
            if kind == "global" and node.value.id in self.stdlib_aliases:
                module = self.stdlib_aliases[node.value.id]
                return ("stdlib", module if module != "collections.abc" else "typing", node.attr)
        return None

    def attr_name(self, node: ast.Attribute) -> str:
        return node.attr

    def expr_Attribute(self, node: ast.Attribute, receiver: bool = False) -> str:
        if isinstance(node.value, ast.Call) and _is_super_call(node.value):
            self.check_super(node.value)
            return f"super.{node.attr}"
        if isinstance(node.value, ast.Name) and self.static_ref(node) is not None:
            return self.stdlib_member(node)
        if isinstance(node.value, ast.Name) and node.value.id in self.sdk_modules \
                and self.ctx.scope.resolve(node.value.id)[0] == "global":
            self.check_renamed(node, self.sdk_modules[node.value.id], node.attr)
        obj = self.expr(node.value, receiver=True)
        attr = self.attr_name(node)
        if receiver and attr not in N.JS_PROTOTYPE_NAMES:
            return f"{obj}.{attr}"
        return f"{RT}.attr({obj}, {json.dumps(attr)})"

    def check_renamed(self, node: ast.AST, module: str, name: str) -> None:
        """PP6012 naming the replacement when `module.name` is an SDK name that was renamed or moved."""
        new = SDK_RENAMED.get((module, name))
        if new is not None:
            raise self.error(node, "PP6012", f"'{module}.{name}' was renamed: it is now {new}",
                             f"Use {new}.")

    def stdlib_member(self, node: ast.Attribute) -> str:
        module = self.stdlib_aliases[node.value.id]  # type: ignore[attr-defined]
        members = N.STDLIB[module]
        if node.attr not in members:
            available = ", ".join(sorted(members)) or "(nothing yet)"
            raise self.error(node, "PP6012", f"'{module}.{node.attr}' is not available in Parallax Python",
                             f"Available from {module}: {available}.")
        return f"{RT}.{members[node.attr]}"

    def check_super(self, call: ast.Call) -> None:
        if call.args or call.keywords:
            raise self.unsupported(call, "super() with arguments", "Use super() with no arguments.", code="PP6030")
        if not self.ctx.super_ok:
            raise self.unsupported(call, "super() outside a method body",
                                   "Call super() directly in the method, not in a nested function or lambda.",
                                   code="PP6030")

    def expr_Subscript(self, node: ast.Subscript, receiver: bool = False) -> str:
        obj = self.expr(node.value, receiver=True)
        if isinstance(node.slice, ast.Slice):
            lo, hi, step = self.slice_parts(node.slice)
            return f"{RT}.getslice({obj}, {lo}, {hi}, {step})"
        return f"{RT}.getitem({obj}, {self.expr(node.slice)})"

    def slice_parts(self, node: ast.Slice) -> tuple[str, str, str]:
        return tuple(self.expr(p) if p is not None else "null" for p in (node.lower, node.upper, node.step))  # type: ignore[return-value]

    def expr_Slice(self, node: ast.Slice) -> str:
        raise self.unsupported(node, "A slice outside a subscript", "Write xs[a:b] inline.", code="PP6021")

    def expr_Tuple(self, node: ast.Tuple) -> str:
        return f"{RT}.tup([{self.elements(node.elts)}])"

    def expr_List(self, node: ast.List) -> str:
        return f"[{self.elements(node.elts)}]"

    def expr_Set(self, node: ast.Set) -> str:
        return f"{RT}.set_of([{self.elements(node.elts)}])"

    def elements(self, elts: list[ast.expr]) -> str:
        return ", ".join(f"...{RT}.iterate({self.expr(e.value)})" if isinstance(e, ast.Starred) else self.expr(e)
                         for e in elts)

    def expr_Dict(self, node: ast.Dict) -> str:
        if all(k is not None for k in node.keys):
            items = ", ".join(f"{self.expr(k)}, {self.expr(v)}" for k, v in zip(node.keys, node.values))  # type: ignore[arg-type]
            return f"{RT}.dict_of([{items}])"
        parts = []
        for k, v in zip(node.keys, node.values):
            parts.append(f"{RT}.SPLAT, {self.expr(v)}" if k is None else f"{self.expr(k)}, {self.expr(v)}")
        return f"{RT}.dict_of([{', '.join(parts)}])"

    def expr_Starred(self, node: ast.Starred) -> str:
        raise self.unsupported(node, "A starred expression here", "Use *x only in calls, lists, tuples and sets.",
                               code="PP6021")

    def expr_UnaryOp(self, node: ast.UnaryOp) -> str:
        if isinstance(node.op, ast.Not):
            return f"!{self.test(node.operand)}"
        if isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant) \
                and type(node.operand.value) in (int, float):
            return f"(-{self.expr(node.operand)})"
        fn = {ast.USub: "neg", ast.UAdd: "pos", ast.Invert: "invert"}[type(node.op)]
        return f"{RT}.{fn}({self.expr(node.operand)})"

    def expr_BinOp(self, node: ast.BinOp) -> str:
        if isinstance(node.op, ast.Mod) and isinstance(node.left, (ast.Constant, ast.JoinedStr)) \
                and (isinstance(node.left, ast.JoinedStr) or isinstance(node.left.value, str)):
            raise self.error(node, "PP6106", "printf-style '%' formatting is not supported in Parallax Python",
                             'Use an f-string: f"{value:.2f}"')
        return f"{RT}.{BINOPS[type(node.op)]}({self.expr(node.left)}, {self.expr(node.right)})"

    def expr_BoolOp(self, node: ast.BoolOp) -> str:
        if all(self.is_bool(v) for v in node.values):
            return self.test(node)
        tmp = self.temp()
        result = self.expr(node.values[-1])
        for value in reversed(node.values[:-1]):
            if isinstance(node.op, ast.Or):
                result = f"({RT}.truthy({tmp} = {self.expr(value)}) ? {tmp} : {result})"
            else:
                result = f"(!{RT}.truthy({tmp} = {self.expr(value)}) ? {tmp} : {result})"
        return result

    def expr_IfExp(self, node: ast.IfExp) -> str:
        return f"({self.test(node.test)} ? {self.expr(node.body)} : {self.expr(node.orelse)})"

    def expr_Compare(self, node: ast.Compare) -> str:
        operands = [node.left, *node.comparators]
        parts = []
        left = self.expr(node.left)
        for i, (op, right_node) in enumerate(zip(node.ops, node.comparators)):
            right = self.expr(right_node)
            last = i == len(node.ops) - 1
            if not last and not _is_simple(right_node):
                tmp = self.temp()
                parts.append(self.compare_one(op, left, f"({tmp} = {right})", operands[i], right_node))
                left = tmp
            else:
                parts.append(self.compare_one(op, left, right, operands[i], right_node))
                left = right
        return parts[0] if len(parts) == 1 else "(" + " && ".join(parts) + ")"

    def compare_one(self, op: ast.cmpop, left: str, right: str, left_node: ast.expr, right_node: ast.expr) -> str:
        if isinstance(op, (ast.Is, ast.IsNot)):
            none = _is_none(left_node) or _is_none(right_node)
            if isinstance(op, ast.Is):
                return f"({left} == {right})" if none else f"({left} === {right})"
            return f"({left} != {right})" if none else f"({left} !== {right})"
        if isinstance(op, ast.In):
            return f"{RT}.in_({left}, {right})"
        if isinstance(op, ast.NotIn):
            return f"!{RT}.in_({left}, {right})"
        return f"{RT}.{CMPOPS[type(op)]}({left}, {right})"

    def expr_Lambda(self, node: ast.Lambda) -> str:
        pre, fn = self.function_expr(node, method=False)
        if pre:
            # defaults are evaluated when the lambda expression is
            sig = pre[0].split(" = ", 1)
            name = sig[0].removeprefix("const ")
            return f"(({name}) => ({fn}))({sig[1].rstrip(';')})"
        return f"({fn})"

    def expr_NamedExpr(self, node: ast.NamedExpr) -> str:
        return f"({N.js_name(node.target.id)} = {self.expr(node.value)})"

    def expr_Await(self, node: ast.Await) -> str:
        if not self.ctx.is_async:
            raise self.unsupported(node, "'await' outside an async def body",
                                   "Await directly in the async def, not in a lambda or comprehension.", code="PP6021")
        return f"(yield* {RT}.await_({self.expr(node.value)}))"

    def expr_Yield(self, node: ast.expr) -> str:
        raise self.unsupported(node, "'yield'", "Build and return a list; for a sequence over time use an async task.",
                               code="PP6021")

    expr_YieldFrom = expr_Yield

    # ── Comprehensions ──────────────────────────────────────────────────────────

    def comprehension(self, node: ast.ListComp | ast.SetComp | ast.DictComp | ast.GeneratorExp) -> str:
        scope = self.scopes.of(node)
        first = f"{RT}.iterate({self.expr(node.generators[0].iter)})"
        outer = self.ctx
        self.ctx = FnCtx(scope, self_name=outer.self_name)
        try:
            if isinstance(node, ast.ListComp):
                inner = [f"$r.push({self.expr(node.elt)});"]
            elif isinstance(node, ast.SetComp):
                inner = [f"$r.add({self.expr(node.elt)});"]
            elif isinstance(node, ast.DictComp):
                inner = [f"{RT}.setitem($r, {self.expr(node.key)}, {self.expr(node.value)});"]
            else:
                inner = [f"yield {self.expr(node.elt)};"]
            for i, gen in reversed(list(enumerate(node.generators))):
                if gen.is_async:
                    raise self.unsupported(node, "An async comprehension", "Use a plain loop.", code="PP6021")
                conds = [f"if (!({self.test(c)})) continue;" for c in gen.ifs]
                head, unpack = self.loop_target(gen.target)
                iterable = "$i" if i == 0 else f"{RT}.iterate({self.expr(gen.iter)})"
                inner = [f"for ({head} of {iterable}) {{", *self.indent(unpack + conds + inner), "}"]
            ctx = self.ctx
        finally:
            self.ctx = outer
        decl = [N.js_name(n) for n in scope.locals_to_declare()] + ctx.temps
        lets = [f"let {', '.join(decl)};"] if decl else []
        if isinstance(node, ast.GeneratorExp):
            body = "\n".join([*lets, *ctx.pre, *inner])
            return f"(function* ($i) {{\n{body}\n}})({first})"
        init = {ast.ListComp: "[]", ast.SetComp: f"{RT}.set_of([])", ast.DictComp: f"{RT}.dict_of([])"}[type(node)]
        body = "\n".join([*lets, *ctx.pre, f"const $r = {init};", *inner, "return $r;"])
        return f"(($i) => {{\n{body}\n}})({first})"

    expr_ListComp = comprehension
    expr_SetComp = comprehension
    expr_DictComp = comprehension
    expr_GeneratorExp = comprehension

    # ── Calls ───────────────────────────────────────────────────────────────────

    def call_args(self, node: ast.Call) -> str:
        args = [f"...{RT}.iterate({self.expr(a.value)})" if isinstance(a, ast.Starred) else self.expr(a)
                for a in node.args]
        if node.keywords:
            args.append(self.kwargs(node))
        return ", ".join(args)

    def kwargs(self, node: ast.Call) -> str:
        for k in node.keywords:
            if k.arg is not None and (k.arg in ("__proto__", "constructor", "prototype")):
                raise self.error(k, "PP6003", f"The keyword '{k.arg}' is not allowed", "Rename the parameter.")
        if all(k.arg is not None for k in node.keywords):
            items = ", ".join(f"{json.dumps(k.arg)}: {self.expr(k.value)}" for k in node.keywords)
            return f"{RT}.kw({{ {items} }})"
        parts = [f"{RT}.SPLAT, {self.expr(k.value)}" if k.arg is None else f"{json.dumps(k.arg)}, {self.expr(k.value)}"
                 for k in node.keywords]
        return f"{RT}.kw_merge([{', '.join(parts)}])"

    def call_value(self, node: ast.expr) -> str:
        """A decorator expression: evaluated as an ordinary expression."""
        return self.expr(node)

    def expr_Call(self, node: ast.Call) -> str:
        func = node.func
        if _is_super_call(node):
            raise self.unsupported(node, "A bare super() call", "Use super().method(...).", code="PP6030")
        if isinstance(func, ast.Name):
            return self.call_name(node, func)
        if isinstance(func, ast.Attribute):
            return self.call_attribute(node, func)
        return f"{RT}.call({self.expr(func)}{self._comma(node)})"

    def _comma(self, node: ast.Call) -> str:
        args = self.call_args(node)
        return f", {args}" if args else ""

    def call_name(self, node: ast.Call, func: ast.Name) -> str:
        kind, owner = self.ctx.scope.resolve(func.id)
        if kind == "builtin":
            if func.id in N.DECORATOR_BUILTINS:
                raise self.unsupported(node, f"Calling {func.id}()", f"Use @{func.id} on a method.", code="PP6011")
            target = self.name_load(func.id, func)
            if func.id in ("str", "repr") and len(node.args) == 1 and not node.keywords and self.is_float(node.args[0]):
                return f"{RT}.{func.id}_float({self.expr(node.args[0])})"
            if func.id == "print" and not any(isinstance(a, ast.Starred) for a in node.args):
                args = [f"{RT}.str_float({self.expr(a)})" if self.is_float(a) else self.expr(a) for a in node.args]
                if node.keywords:
                    args.append(self.kwargs(node))
                return f"{target}({', '.join(args)})"
            if func.id in N.BUILTIN_CLASSES:
                return f"new {target}({self.call_args(node)})"
            return f"{target}({self.call_args(node)})"
        callee = self.name_load(func.id, func)
        binding = owner.bindings.get(func.id) if owner is not None else None
        ref = self.static_ref(func)
        if ref is not None and ref[0] == "stdlib":
            if (ref[1], ref[2]) in STDLIB_CLASSES:
                return f"{RT}.call({callee}{self._comma(node)})"
            return f"{callee}({self.call_args(node)})"
        if binding is not None and kind != "class":
            if binding.only_plain_defs:
                return f"{callee}({self.call_args(node)})"
            cls = binding.only_plain_class
            if cls is not None and not cls.bases:
                return f"new {callee}({self.call_args(node)})"
        return f"{RT}.call({callee}{self._comma(node)})"

    def call_attribute(self, node: ast.Call, func: ast.Attribute) -> str:
        name = func.attr
        if isinstance(func.value, ast.Call) and _is_super_call(func.value):
            self.check_super(func.value)
            return f"super.{name}({self.call_args(node)})"
        ref = self.static_ref(func)
        if ref is not None and ref[0] == "stdlib" and isinstance(func.value, ast.Name):
            callee = self.stdlib_member(func)
            if (ref[1], ref[2]) in STDLIB_CLASSES:
                return f"{RT}.call({callee}{self._comma(node)})"
            return f"{callee}({self.call_args(node)})"
        if isinstance(func.value, ast.Name) and func.value.id in self.sdk_modules \
                and self.ctx.scope.resolve(func.value.id)[0] == "global":
            self.check_renamed(func, self.sdk_modules[func.value.id], name)
        if name in N.UNSUPPORTED_STR_METHODS and _is_str_literal(func.value):
            code, fix = N.UNSUPPORTED_STR_METHODS[name]
            raise self.error(node, code, f"'str.{name}' is not supported in Parallax Python", f"Instead, {fix}.")
        obj = self.expr(func.value, receiver=True)
        args = self.call_args(node)
        if name in N.DISPATCHED_METHODS:
            return f"{RT}.M.{name}({obj}{', ' + args if args else ''})"
        if name in N.JS_PROTOTYPE_NAMES or name in N.UNSUPPORTED_STR_METHODS or name[:1].isupper():
            return f"{RT}.callm({obj}, {json.dumps(name)}{', ' + args if args else ''})"
        return f"{obj}.{name}({args})"

    # ── Type expressions (class annotations, aliases) ──────────────────────────

    def type_expr(self, node: ast.expr) -> str:
        T = f"{RT}.types"
        if isinstance(node, ast.Constant):
            if node.value is None:
                return f"{T}.none"
            if isinstance(node.value, str):
                try:
                    parsed = ast.parse(node.value, mode="eval").body
                except SyntaxError:
                    raise self.error(node, "PP6040", f"The annotation {node.value!r} is not a type expression",
                                     "Write the type without quotes, or fix the quoted expression.")
                ast.copy_location(parsed, node)
                for child in ast.walk(parsed):
                    ast.copy_location(child, node)
                return self.type_expr(parsed)
            if node.value is Ellipsis:
                return f"{RT}.Ellipsis"
        if isinstance(node, ast.Name):
            kind, _ = self.ctx.scope.resolve(node.id)
            if kind == "builtin" and node.id in ("float", "int", "str", "bool"):
                return f"{T}.{node.id}"
            if kind == "builtin" and node.id in ("list", "dict", "set", "frozenset", "tuple"):
                return f"{T}.{node.id}()"
            ref = self.static_ref(node)
            if ref is not None and ref[0] == "stdlib" and ref[1] == "typing" and ref[2] == "Any":
                return f"{T}.any"
            return self.expr(node)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            members = _union_members(node)
            non_none = [m for m in members if not _is_none(m)]
            inner = self.type_expr(non_none[0]) if len(non_none) == 1 else \
                f"{T}.union({', '.join(self.type_expr(m) for m in non_none)})"
            return f"{T}.optional({inner})" if len(non_none) < len(members) else inner
        if isinstance(node, ast.Subscript):
            args = list(node.slice.elts) if isinstance(node.slice, ast.Tuple) else [node.slice]
            base = node.value
            if isinstance(base, ast.Name) and self.ctx.scope.resolve(base.id)[0] == "builtin" \
                    and base.id in ("list", "dict", "set", "frozenset", "tuple", "type"):
                return f"{T}.{base.id}({', '.join(self.type_expr(a) for a in args)})"
            ref = self.static_ref(base)
            if ref is not None and ref[0] == "stdlib" and ref[1] == "typing":
                name = ref[2]
                if name == "Literal":
                    return f"{T}.literal({', '.join(self.expr(a) for a in args)})"
                if name == "Optional":
                    return f"{T}.optional({self.type_expr(args[0])})"
                if name == "Union":
                    non_none = [a for a in args if not _is_none(a)]
                    inner = self.type_expr(non_none[0]) if len(non_none) == 1 else \
                        f"{T}.union({', '.join(self.type_expr(a) for a in non_none)})"
                    return f"{T}.optional({inner})" if len(non_none) < len(args) else inner
                if name == "Callable":
                    return f"{T}.callable()"
                if name in ("ClassVar", "Final"):
                    return f"{T}.{name.lower()}({self.type_expr(args[0])})"
            if isinstance(node.slice, ast.List):
                raise self.error(node, "PP6040", "A list inside a type subscript", "Use Callable or a plain class.")
            return f"{T}.generic({self.expr(base)}, {', '.join(self.type_expr(a) for a in args)})"
        if isinstance(node, ast.Attribute):
            return self.expr(node)
        if isinstance(node, ast.List):
            return f"[{', '.join(self.type_expr(e) for e in node.elts)}]"
        raise self.error(node, "PP6040", "This annotation is not a supported type expression",
                         "Use a class, a builtin type, X | None, list[T], dict[K, V], tuple[...] or Literal[...].")


# ── Helpers ─────────────────────────────────────────────────────────────────────

_STATEMENT_FIX = {
    "With": "Call the setup and cleanup explicitly (try/finally).",
    "AsyncWith": "Call the setup and cleanup explicitly (try/finally).",
    "Match": "Use if/elif chains.",
    "TypeAlias": "Assign the type to a name: Cells = tuple[Disc | None, ...].",
}

_EXPRESSION_FIX = {
    "Yield": "Build and return a list; for a sequence over time use an async task.",
    "YieldFrom": "Build and return a list.",
}


def _skip_docstring(body: list[ast.stmt]) -> list[ast.stmt]:
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        return body[1:]
    return body


def _walk_own(node: ast.AST) -> Iterator[ast.AST]:
    """Nodes of a function body, not descending into nested functions or classes."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        child = stack.pop()
        yield child
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            stack.extend(ast.iter_child_nodes(child))


def _is_super_call(node: ast.expr) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "super"


def _is_none(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and node.value is None


def _is_str_literal(node: ast.expr) -> bool:
    return isinstance(node, ast.JoinedStr) or (isinstance(node, ast.Constant) and isinstance(node.value, str))


def _is_simple(node: ast.expr) -> bool:
    return isinstance(node, (ast.Name, ast.Constant)) or (
        isinstance(node, ast.Attribute) and _is_simple(node.value))


def _needs_value_first(target: ast.expr) -> bool:
    """Python evaluates the value before the target's own subexpressions."""
    if isinstance(target, (ast.Name, ast.Tuple, ast.List)):
        return False
    return any(isinstance(n, (ast.Call, ast.Await, ast.NamedExpr)) for n in ast.walk(target))


def _union_members(node: ast.expr) -> list[ast.expr]:
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return [*_union_members(node.left), *_union_members(node.right)]
    return [node]


def _is_type_alias(node: ast.expr, emitter: ModuleEmitter) -> bool:
    """`Cells = tuple[Disc | None, ...]` — a module-level type alias."""
    if isinstance(node, ast.Subscript):
        base = node.value
        if isinstance(base, ast.Name) and emitter.ctx.scope.resolve(base.id)[0] == "builtin" \
                and base.id in ("list", "dict", "set", "frozenset", "tuple", "type"):
            return True
        ref = emitter.static_ref(base)
        return ref is not None and ref[0] == "stdlib" and ref[1] == "typing"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return any(_is_none(m) or _is_type_alias(m, emitter) for m in _union_members(node))
    return False


def _stdlib_module_js(module: str) -> str:
    return "typing" if module == "collections.abc" else module


def _export_spec(name: str) -> str:
    js = N.js_name(name)
    return js if js == name else f"{js} as {name}"
