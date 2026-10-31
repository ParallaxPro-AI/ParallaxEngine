"""The declarations pass: every decorator and declaration in a project, read statically.

Produces the `build/declarations.json` document (contract C2). Field schemas
use the kernel's FieldType JSON; defaults are in authored-JSON form (what a data file
would say: `[0, 1]` for a vector, `"#ff0000"` for a color), which `decode()` turns into
runtime values. Anything that can't be read without running the game is a coded
diagnostic, never a guess.
"""

import ast
from dataclasses import dataclass, field

from parallax_transpiler.diagnostics import Diagnostic
from parallax_transpiler.extract.keys import KEY_CODES
from parallax_transpiler.extract.resolve import (
    AssignV, AttrV, BuiltinV, ClassV, FuncV, ModuleV, ProjectV, Resolver, TagV, Unknown, Value,
)
from parallax_transpiler.extract.shapes import ShapeReader
from parallax_transpiler.extract.sources import Module
from parallax_transpiler.extract.types import (
    BUILTIN_TYPES, CELL3_CONSTANTS, CELL_CONSTANTS, CELL_TYPES, COLOR_CONSTANTS, DICT_NAMES, LIST_NAMES,
    REF_TYPES, RUNTIME_ONLY_TYPES, VALUE_TYPES, VEC2_CONSTANTS, VEC3_CONSTANTS, Json, TypeInfo, nest_localized,
)

FORMAT_VERSION = 1

# Which plugin provides each SDK module's components, events and content kinds.
PLUGINS_OF_MODULE: dict[str, list[str]] = {
    "parallax": ["core"],
    "parallax.physics": ["physics2d", "physics3d"],
    "parallax.combat": ["combat"],
    "parallax.characters": ["characters"],
    "parallax.vehicles": ["vehicles"],
    "parallax.nav": ["nav"],
    "parallax.grid": ["grid"],
    "parallax.story": ["story"],
    "parallax.voxels": ["voxels"],
    "parallax.procgen": ["procgen"],
    "parallax.city": ["city"],
    "parallax.net": ["net"],
    "parallax.save": ["save"],
    "parallax.terrain": ["terrain"],
    "parallax.foliage": ["foliage"],
    "parallax.wind": ["wind"],
    "parallax.hud": ["hud"],
    "parallax.destruction": ["destruction"],
    "parallax.ai": ["ai"],
    "parallax.viewmodel": ["viewmodel"],
    "parallax.interaction": ["interaction"],
    "parallax.water": ["water"],
    "parallax.weather": ["weather"],
    "parallax.economy": ["economy"],
    "parallax.spawning": ["spawning"],
    "parallax.cinematics": ["cinematics"],
    "parallax.softbody": ["softbody"],
    "parallax.screens": ["screens"],
    "parallax.voice": ["voice"],
    "parallax.chat": ["chat"],
    "parallax.payments": ["payments"],
}

# Classes more than one plugin provides (the runtime registers one shared definition).
PLUGINS_OF_CLASS: dict[tuple[str, str], list[str]] = {
    ("parallax.characters", "Seat"): ["characters", "vehicles"],  # a vehicle's seats are Seat children
}

DATA_DECORATORS = ("component", "resource", "config", "content", "record", "event", "behavior", "system", "ui")
DECORATOR_KEYWORDS: dict[str, frozenset[str]] = {
    "component": frozenset(),
    "resource": frozenset({"keep"}),
    "config": frozenset(),
    "content": frozenset({"order"}),
    "record": frozenset(),
    "event": frozenset({"target"}),
    "behavior": frozenset({"requires", "tick", "when"}),
    "system": frozenset({"scenes", "when", "after", "runs_while_frozen", "runs_on"}),
    "ui": frozenset({"html", "modal", "layer", "scenes", "when", "delay", "toggle_with", "while_held", "cursor", "scale"}),
}
FIELD_FUNCTIONS: dict[str, tuple[str, ...]] = {
    "field": ("default", "min", "max", "unit", "choices", "doc", "keep", "replicate", "modifiable"),
    "param": ("default", "min", "max", "unit", "choices", "doc"),
    "state": ("default", "doc"),
}
# Hook name → number of parameters after `self`.
BEHAVIOR_HOOKS = {"start": 1, "update": 2, "fixed_update": 2, "late_update": 2, "end": 1}
SYSTEM_HOOKS = {"start": 1, "update": 2, "fixed_update": 2, "late_update": 2}
HOOK_MISTAKES = {"destroy": "end", "on_destroy": "end", "awake": "start", "init": "start", "on_start": "start",
                 "on_update": "update", "tick": "update", "physics_update": "fixed_update",
                 "fixedupdate": "fixed_update", "lateupdate": "late_update", "on_end": "end"}
KEEPS = ("scene", "run", "session", "profile")
LAYERS = ("hud", "menu", "overlay")
PANEL_SCALES = ("viewport", "design", "none")
RUNS_ON = ("server", "client", "everywhere")
PANEL_COMMANDS = ("close_panel", "open_panel", "reload_scene", "load_scene")
ACTION_KINDS = ("button", "axis1", "axis2", "button_group")
BINDING_DEVICES = {
    "button": ("keyboard", "gamepad", "mouse", "touch", "repeat"),
    "axis1": ("negative", "positive", "gamepad", "mouse", "touch"),
    "axis2": ("keyboard", "gamepad", "mouse", "touch", "repeat"),
    "button_group": ("keyboard", "gamepad", "touch_labels", "touch"),
}
KEY_ARGUMENTS = ("keyboard", "negative", "positive")
BINDING_CLASSES = ("keys", "gamepad", "mouse", "touch")
BUILTIN_PANELS = ("SettingsPanel", "DialoguePanel")
ENUM_BASES = frozenset({"Enum", "StrEnum", "IntEnum"})


class NotStatic(Exception):
    """A value that needs running code to know."""


@dataclass
class ClassInfo:
    ref: ClassV
    node: ast.ClassDef
    module: Module
    kind: str
    """component resource config content record event behavior system panel actions enum plain"""
    id: str | None = None
    keywords: dict[str, ast.expr] = field(default_factory=dict)
    decorator: ast.expr | None = None


def _qualified(ref: ClassV | FuncV) -> str:
    return f"{ref.module}.{ref.name}"


def _const(node: ast.expr | None) -> object:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant) \
            and isinstance(node.operand.value, (int, float)):
        return -node.operand.value
    raise NotStatic(ast.unparse(node) if node is not None else "nothing")


def _docstring(body: list[ast.stmt]) -> str | None:
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        return " ".join(body[0].value.value.split())
    return None


def _close(name: str, options: tuple[str, ...] | list[str]) -> str | None:
    best, best_distance = None, 3
    for option in options:
        distance = _edit_distance(name, option)
        if distance < best_distance:
            best, best_distance = option, distance
    return best


def _edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


class Extractor:
    def __init__(self, project: dict[str, Module], sdk: dict[str, Module]) -> None:
        self.project = project
        self.sdk = sdk
        self.modules = {**sdk, **project}
        self.resolver = Resolver(self.modules)
        self.diagnostics: list[Diagnostic] = []
        self.approximations: list[dict[str, Json]] = []
        self._classes: dict[ClassV, ClassInfo] = {}
        self._fields: dict[ClassV, dict[str, dict[str, Json]]] = {}
        self._localized: dict[ClassV, list[str]] = {}
        self._record_stack: list[ClassV] = []
        self._shapes = ShapeReader(self._function_for_shape)
        self._shape_module: Module = next(iter(self.modules.values()))

    # ── diagnostics ─────────────────────────────────────────────────────────

    def report(self, module: Module, node: ast.AST, code: str, message: str, fix: str | None = None,
               severity: str = "error") -> None:
        if module.sdk:
            # The SDK stubs are the contract; a stub this pass can't read is an internal error.
            code, severity = "PP9001", "error"
            message = f"SDK stub: {message}"
        self.diagnostics.append(Diagnostic(
            code=code, message=message, path=module.path,
            line=getattr(node, "lineno", 1), column=getattr(node, "col_offset", 0),
            fix=fix, severity=severity,
        ))

    # ── resolution helpers ──────────────────────────────────────────────────

    def resolve(self, module: Module, expr: ast.expr) -> Value:
        return self.resolver.resolve(module.name, expr)

    def sdk_function(self, value: Value) -> str | None:
        """The SDK function name a value refers to (`field`, `component`, `close_panel`…)."""
        if isinstance(value, FuncV) and value.module in self.sdk:
            return value.name
        return None

    def sdk_class(self, value: Value) -> str | None:
        """The SDK class name a value refers to (`Game`, `Feature`, `Vec2`…)."""
        if isinstance(value, ClassV) and value.module in self.sdk:
            return value.name
        return None

    def is_subclass(self, cls: ClassV, module: str, name: str, seen: frozenset[ClassV] = frozenset()) -> bool:
        if cls == ClassV(module, name):
            return True
        if cls in seen:
            return False
        for base in self.bases(cls):
            if isinstance(base, ClassV) and self.is_subclass(base, module, name, seen | {cls}):
                return True
        return False

    def bases(self, cls: ClassV) -> list[Value]:
        node = self.resolver.class_node(cls)
        return [self.resolver.resolve(cls.module, base) for base in node.bases
                if not (isinstance(base, ast.Subscript))] + [
            self.resolver.resolve(cls.module, base.value) for base in node.bases if isinstance(base, ast.Subscript)]

    def is_enum(self, cls: ClassV, seen: frozenset[ClassV] = frozenset()) -> bool:
        for base in self.bases(cls):
            if isinstance(base, BuiltinV) and base.name in ENUM_BASES:
                return True
            if isinstance(base, ClassV) and base not in seen and self.is_enum(base, seen | {cls}):
                return True
        return False

    def class_info(self, cls: ClassV) -> ClassInfo:
        if cls in self._classes:
            return self._classes[cls]
        module = self.modules[cls.module]
        node = self.resolver.class_node(cls)
        info = ClassInfo(cls, node, module, "plain")
        self._classes[cls] = info
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            fn = self.sdk_function(self.resolve(module, call.func if call else decorator))
            if fn not in DATA_DECORATORS:
                continue
            info.kind = "panel" if fn == "ui" else fn
            info.decorator = decorator
            if fn == "record":
                break
            if call is None or not call.args:
                self.report(module, decorator, "PP1103", f"@{fn} needs an id: @{fn}(\"{_snake(node.name)}\")")
                break
            try:
                ident = _const(call.args[0])
            except NotStatic:
                ident = None
            if not isinstance(ident, str):
                self.report(module, call.args[0], "PP1103", f"The @{fn} id must be a string literal",
                            fix=f"Write @{fn}(\"{_snake(node.name)}\").")
                break
            info.id = ident
            allowed = DECORATOR_KEYWORDS[fn]
            for kw in call.keywords:
                if kw.arg is None or kw.arg not in allowed:
                    guess = _close(kw.arg or "", tuple(allowed))
                    self.report(module, kw, "PP4005", f"@{fn} has no option '{kw.arg}'",
                                fix=f"Did you mean '{guess}'?" if guess else f"Options: {', '.join(sorted(allowed)) or '(none)'}.")
                    continue
                info.keywords[kw.arg] = kw.value
            break
        if info.kind == "plain":
            if self.is_enum(cls):
                info.kind = "enum"
            elif self.is_subclass(cls, "parallax", "Actions"):
                info.kind = "actions"
        return info

    # ── field types ─────────────────────────────────────────────────────────

    def field_type(self, module: Module, ann: ast.expr) -> TypeInfo:
        if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
            try:
                parsed = ast.parse(ann.value, mode="eval").body
            except SyntaxError:
                raise NotStatic(f"'{ann.value}' is not a type") from None
            return self.field_type(module, parsed)
        if isinstance(ann, ast.BinOp) and isinstance(ann.op, ast.BitOr):
            return self._union(module, _union_members(ann), ann)
        if isinstance(ann, ast.Subscript):
            return self._generic(module, ann)
        value = self.resolve(module, ann)
        return self._named_type(module, value, ann)

    def _named_type(self, module: Module, value: Value, ann: ast.expr) -> TypeInfo:
        if isinstance(value, BuiltinV):
            if value.name in BUILTIN_TYPES:
                return TypeInfo(dict(BUILTIN_TYPES[value.name]))
            if value.name in LIST_NAMES:
                return TypeInfo({"kind": "list", "of": {"kind": "json"}})
            if value.name in DICT_NAMES:
                return TypeInfo({"kind": "dict", "of": {"kind": "json"}})
            raise NotStatic(f"'{ast.unparse(ann)}' is not a field type")
        if isinstance(value, ClassV):
            key = (value.module, value.name)
            if key in VALUE_TYPES:
                return TypeInfo(dict(VALUE_TYPES[key]))
            if key in REF_TYPES:
                return TypeInfo(dict(REF_TYPES[key]))
            if key == ("parallax", "Localized"):
                return TypeInfo({"kind": "string"}, localized=[""])
            if key in CELL_TYPES:
                return TypeInfo({"kind": "list", "of": {"kind": "int"}},
                                approximations=[f"{value.name} → list[int] (the kernel has no cell kind)"])
            if key == ("parallax", "Quat"):
                return TypeInfo({"kind": "json"}, approximations=["Quat → json (the kernel has no quaternion kind)"])
            if key in RUNTIME_ONLY_TYPES:
                return TypeInfo({"kind": "json"}, runtime_only=True)
            info = self.class_info(value)
            if info.kind == "enum":
                return TypeInfo({"kind": "enum", "values": self.enum_values(value)})
            if info.kind == "record":
                if value in self._record_stack:
                    return TypeInfo({"kind": "json"},
                                    approximations=[f"recursive record {value.name} → json"])
                self._record_stack.append(value)
                try:
                    fields = self.fields(value)
                    return TypeInfo({"kind": "record", "fields": fields}, localized=list(self._localized[value]))
                finally:
                    self._record_stack.pop()
            if info.kind in ("panel",) or self.is_subclass(value, "parallax", "Panel"):
                return TypeInfo({"kind": "ref", "to": "panel"})
            raise NotStatic(f"'{value.name}' ({info.kind}) is not a field type; fields hold values, refs and @record classes")
        if isinstance(value, AssignV):
            # A type alias: `Cells = tuple[Disc | None, ...]`.
            return self.field_type(self.modules[value.module], self.resolver.assigned(value))
        if isinstance(value, Unknown):
            raise NotStatic(value.reason)
        raise NotStatic(f"'{ast.unparse(ann)}' is not a field type")

    def _generic(self, module: Module, ann: ast.Subscript) -> TypeInfo:
        base = self.resolve(module, ann.value)
        args = list(ann.slice.elts) if isinstance(ann.slice, ast.Tuple) else [ann.slice]
        name = base.name if isinstance(base, (BuiltinV, ClassV)) else None
        if isinstance(base, BuiltinV) and name == "ClassVar":
            raise NotStatic("ClassVar")
        if isinstance(base, BuiltinV) and name in LIST_NAMES:
            inner = self.field_type(module, args[0])
            return TypeInfo({"kind": "list", "of": inner.type}, nest_localized("[]", inner.localized),
                            inner.approximations, inner.runtime_only)
        if isinstance(base, BuiltinV) and name in DICT_NAMES:
            key = self.field_type(module, args[0])
            inner = self.field_type(module, args[1])
            approximations = list(inner.approximations)
            if key.type["kind"] not in ("string", "enum", "tag", "ref"):
                approximations.append(f"dict key {ast.unparse(args[0])} → string (JSON object keys are strings)")
            return TypeInfo({"kind": "dict", "of": inner.type}, nest_localized("{}", inner.localized),
                            approximations, inner.runtime_only)
        if isinstance(base, BuiltinV) and name == "Optional":
            inner = self.field_type(module, args[0])
            return TypeInfo({"kind": "optional", "of": inner.type}, inner.localized, inner.approximations, inner.runtime_only)
        if isinstance(base, BuiltinV) and name == "Union":
            return self._union(module, args, ann)
        if isinstance(base, BuiltinV) and name == "Literal":
            values = [a.value for a in args if isinstance(a, ast.Constant)]
            if len(values) == len(args) and all(isinstance(v, str) for v in values):
                return TypeInfo({"kind": "enum", "values": values})
            return TypeInfo({"kind": "json"}, approximations=[f"{ast.unparse(ann)} → json (only str literals map to enum)"])
        if isinstance(base, BuiltinV) and name in ("tuple", "Tuple"):
            if len(args) == 2 and isinstance(args[1], ast.Constant) and args[1].value is Ellipsis:
                inner = self.field_type(module, args[0])
                return TypeInfo({"kind": "list", "of": inner.type}, nest_localized("[]", inner.localized),
                                inner.approximations, inner.runtime_only)
            members = [self.field_type(module, a) for a in args]
            first = members[0].type
            if all(m.type == first for m in members):
                return TypeInfo({"kind": "list", "of": first}, [], [f"{ast.unparse(ann)} → list (the kernel has no tuple kind; length unchecked)"],
                                any(m.runtime_only for m in members))
            return TypeInfo({"kind": "json"}, [], [f"{ast.unparse(ann)} → json (the kernel has no tuple kind)"],
                            any(m.runtime_only for m in members))
        if isinstance(base, BuiltinV) and name == "type":
            return TypeInfo({"kind": "json"}, runtime_only=True)
        if isinstance(base, ClassV) and (base.module, base.name) == ("parallax", "ContentRef"):
            arg = args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                arg = ast.parse(arg.value, mode="eval").body
            target = self.resolve(module, arg)
            if not isinstance(target, ClassV) or self.class_info(target).kind != "content":
                raise NotStatic(f"ContentRef[{ast.unparse(args[0])}] must name a @content class")
            kind = self.class_info(target).id
            return TypeInfo({"kind": "ref", "to": f"content/{kind}"})
        if isinstance(base, ClassV) and (base.module, base.name) in RUNTIME_ONLY_TYPES:
            return TypeInfo({"kind": "json"}, runtime_only=True)
        raise NotStatic(f"'{ast.unparse(ann)}' is not a field type")

    def _union(self, module: Module, members: list[ast.expr], ann: ast.expr) -> TypeInfo:
        non_none = [m for m in members if not (isinstance(m, ast.Constant) and m.value is None)]
        optional = len(non_none) < len(members)
        if len(non_none) == 1:
            inner = self.field_type(module, non_none[0])
            if not optional:
                return inner
            return TypeInfo({"kind": "optional", "of": inner.type}, inner.localized, inner.approximations, inner.runtime_only)
        infos = [self.field_type(module, m) for m in non_none]
        json_type: dict[str, Json] = {"kind": "json"}
        typed: dict[str, Json] = {"kind": "optional", "of": json_type} if optional else json_type
        return TypeInfo(typed, [], [f"{ast.unparse(ann)} → json (the kernel has no union kind)"],
                        any(i.runtime_only for i in infos))

    def enum_values(self, cls: ClassV) -> list[str]:
        info = self.class_info(cls)
        values: list[str] = []
        for stmt in info.node.body:
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                value = stmt.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    values.append(value.value)
                else:
                    self.report(info.module, stmt, "PP4003",
                                f"Enum {cls.name}.{stmt.targets[0].id} must have a str value to be a field type",
                                fix=f"Write {stmt.targets[0].id} = \"{stmt.targets[0].id.lower()}\" (stored by value in JSON).")
        return values

    def enum_member(self, attr: AttrV) -> str:
        info = self.class_info(attr.owner)
        for stmt in info.node.body:
            if isinstance(stmt, ast.Assign) and any(isinstance(t, ast.Name) and t.id == attr.name for t in stmt.targets):
                value = stmt.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    return value.value
        raise NotStatic(f"{attr.owner.name}.{attr.name}")

    # ── default values ──────────────────────────────────────────────────────

    def value(self, module: Module, node: ast.expr, depth: int = 0) -> Json:
        """A static expression in authored-JSON form, or NotStatic."""
        if depth > 20:
            raise NotStatic(ast.unparse(node))
        if isinstance(node, ast.Constant):
            if node.value is Ellipsis or isinstance(node.value, bytes | complex):
                raise NotStatic(ast.unparse(node))
            return node.value  # type: ignore[return-value]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            inner = self.value(module, node.operand, depth + 1)
            if isinstance(inner, (int, float)) and not isinstance(inner, bool):
                return -inner if isinstance(node.op, ast.USub) else inner
            raise NotStatic(ast.unparse(node))
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return [self.value(module, e, depth + 1) for e in node.elts]
        if isinstance(node, ast.Dict):
            out: dict[str, Json] = {}
            for key, val in zip(node.keys, node.values):
                if key is None:
                    raise NotStatic(ast.unparse(node))
                k = self.value(module, key, depth + 1)
                out[str(k)] = self.value(module, val, depth + 1)
            return out
        if isinstance(node, ast.BinOp):
            sequence = isinstance(node.left, (ast.List, ast.Tuple))
            return _arithmetic(node, self.value(module, node.left, depth + 1), self.value(module, node.right, depth + 1), sequence)
        if isinstance(node, ast.Call):
            return self._call_value(module, node, depth)
        if isinstance(node, (ast.Name, ast.Attribute)):
            return self._named_value(module, self.resolve(module, node), node, depth)
        raise NotStatic(ast.unparse(node))

    def _named_value(self, module: Module, value: Value, node: ast.expr, depth: int) -> Json:
        if isinstance(value, AssignV):
            return self.value(self.modules[value.module], self.resolver.assigned(value), depth + 1)
        if isinstance(value, TagV):
            return value.id
        if isinstance(value, ProjectV):
            return _project_ref_value(value)
        if isinstance(value, AttrV):
            owner = (value.owner.module, value.owner.name)
            if owner == ("parallax", "Vec2") and value.name in VEC2_CONSTANTS:
                return list(VEC2_CONSTANTS[value.name])
            if owner == ("parallax", "Vec3") and value.name in VEC3_CONSTANTS:
                return list(VEC3_CONSTANTS[value.name])
            if owner == ("parallax", "Color") and value.name in COLOR_CONSTANTS:
                return COLOR_CONSTANTS[value.name]
            if owner == ("parallax.values", "Cell") and value.name in CELL_CONSTANTS:
                return list(CELL_CONSTANTS[value.name])
            if owner == ("parallax.values", "Cell3") and value.name in CELL3_CONSTANTS:
                return list(CELL3_CONSTANTS[value.name])
            if self.class_info(value.owner).kind == "enum":
                return self.enum_member(value)
        if isinstance(value, BuiltinV) and value.name in ("math.pi", "math.tau", "math.inf", "math.e"):
            import math
            return getattr(math, value.name.split(".")[1])
        raise NotStatic(ast.unparse(node))

    def _call_value(self, module: Module, node: ast.Call, depth: int) -> Json:
        if isinstance(node.func, ast.Attribute) and node.func.attr == "with_alpha" and len(node.args) == 1:
            color = self.value(module, node.func.value, depth + 1)
            alpha = self.value(module, node.args[0], depth + 1)
            if isinstance(color, str) and isinstance(alpha, (int, float)):
                return _hex_rgba(color, float(alpha))
            if isinstance(color, list) and len(color) >= 3 and isinstance(alpha, (int, float)):
                return [*color[:3], alpha]
            raise NotStatic(ast.unparse(node))
        if isinstance(node.func, ast.Name) and node.func.id == "len" and len(node.args) == 1:
            inner = self.value(module, node.args[0], depth + 1)
            if isinstance(inner, (list, str, dict)):
                return len(inner)
            raise NotStatic(ast.unparse(node))
        fn = self.resolve(module, node.func)
        args = [self.value(module, a, depth + 1) for a in node.args]
        kwargs = {kw.arg: self.value(module, kw.value, depth + 1) for kw in node.keywords if kw.arg}
        if any(kw.arg is None for kw in node.keywords):
            raise NotStatic(ast.unparse(node))
        key = (fn.module, fn.name) if isinstance(fn, (FuncV, ClassV)) else None
        if key in (("parallax", "vec2"), ("parallax", "Vec2")):
            return _positional(args, kwargs, ("x", "y"), (0, 0))
        if key in (("parallax", "vec3"), ("parallax", "Vec3")):
            return _positional(args, kwargs, ("x", "y", "z"), (0, 0, 0))
        if key in (("parallax.values", "Cell"),):
            return _positional(args, kwargs, ("col", "row"), (None, None))
        if key in (("parallax.values", "Cell3"),):
            return _positional(args, kwargs, ("x", "y", "z"), (None, None, None))
        if key == ("parallax", "Color"):
            return _positional(args, kwargs, ("r", "g", "b", "a"), (None, None, None, 1))
        if isinstance(fn, AttrV) and (fn.owner.module, fn.owner.name, fn.name) == ("parallax", "Color", "hex"):
            if len(args) == 1 and isinstance(args[0], str):
                return args[0]
        timer_ctor = None
        if key == ("parallax", "Timer"):
            if "start_done" not in kwargs:
                raise NotStatic("Timer(d) must say whether it starts done: "
                                "use Timer.cooldown(d) (ready at once) or Timer.delay(d) (elapses first)")
            timer_ctor = bool(kwargs["start_done"])
        elif isinstance(fn, AttrV) and (fn.owner.module, fn.owner.name) == ("parallax", "Timer") \
                and fn.name in ("cooldown", "delay"):
            if fn.name == "cooldown" and "repeat" in kwargs:
                raise NotStatic("Timer.cooldown(d) takes no repeat=; use Timer.delay(d, repeat=True)")
            timer_ctor = fn.name == "cooldown"
        if timer_ctor is not None:
            duration = args[0] if args else kwargs.get("duration")
            if not isinstance(duration, (int, float)):
                raise NotStatic(ast.unparse(node))
            return {"duration": duration, "remaining": 0 if timer_ctor else duration,
                    "repeat": bool(kwargs.get("repeat", False))}
        if isinstance(fn, BuiltinV) and fn.name in ("list", "dict", "tuple", "set") and not args and not kwargs:
            return {} if fn.name == "dict" else []
        if isinstance(fn, ClassV) and self.class_info(fn).kind == "record":
            schema = self.fields(fn)
            out: dict[str, Json] = {}
            names = list(schema)
            if len(args) > len(names):
                raise NotStatic(ast.unparse(node))
            for name, arg in zip(names, args):
                out[name] = arg
            for name, arg in kwargs.items():
                if name not in schema:
                    raise NotStatic(f"{fn.name} has no field '{name}'")
                out[name] = arg
            for name, spec in schema.items():
                if name not in out:
                    if "default" not in spec:
                        raise NotStatic(f"{fn.name}.{name} is required")
                    out[name] = spec["default"]
            return out
        raise NotStatic(ast.unparse(node))

    # ── fields of a data class ──────────────────────────────────────────────

    def fields(self, cls: ClassV, role: str | None = None) -> dict[str, dict[str, Json]]:
        """Field specs of a component/resource/config/content/record/event class (with
        inherited fields), or of one role ("param"/"state") of a behavior."""
        cache_key = cls if role is None else None
        if cache_key is not None and cache_key in self._fields:
            return self._fields[cache_key]
        info = self.class_info(cls)
        out: dict[str, dict[str, Json]] = {}
        localized: list[str] = []
        for base in self.bases(cls):
            if isinstance(base, ClassV) and (base.module, base.name) not in (("parallax", "EngineComponent"),
                                                                              ("parallax", "Behavior")):
                base_info = self.class_info(base)
                if base_info.kind in ("component", "resource", "config", "content", "record", "event") \
                        or (role is not None and self.is_subclass(base, "parallax", "Behavior")):
                    out.update(self.fields(base, role))
                    localized.extend(self._localized.get(base, []))
        body = info.node.body
        for i, stmt in enumerate(body):
            if not isinstance(stmt, ast.AnnAssign) or not isinstance(stmt.target, ast.Name):
                continue
            name = stmt.target.id
            spec = self._field(info, stmt, role, _attribute_doc(body, i))
            if spec is None:
                continue
            spec_localized = spec.pop("_localized", [])
            out[name] = spec
            localized.extend(nest_localized(name, spec_localized))  # type: ignore[arg-type]
        if cache_key is not None:
            self._fields[cache_key] = out
            self._localized[cls] = localized
        return out

    def _field(self, info: ClassInfo, stmt: ast.AnnAssign, role: str | None, attr_doc: str | None) -> dict[str, Json] | None:
        module = info.module
        name = stmt.target.id  # type: ignore[union-attr]
        value = stmt.value
        call_fn: str | None = None
        if isinstance(value, ast.Call):
            fn = self.sdk_function(self.resolve(module, value.func))
            if fn in FIELD_FUNCTIONS:
                call_fn = fn
        if role is not None:
            # Behaviors: only param()/state() declare fields, and each role is read separately.
            if call_fn != role:
                return None
        elif call_fn in ("param", "state"):
            self.report(module, stmt, "PP4005", f"{call_fn}() declares behavior fields; '{name}' is on a @{info.kind}",
                        fix=f"Use field(...) here.")
            return None
        try:
            typed = self.field_type(module, stmt.annotation)
        except NotStatic as error:
            if str(error) == "ClassVar":
                return None
            self.report(module, stmt.annotation, "PP4001", f"Field '{name}' has an unsupported type: {error}",
                        fix="Use bool/int/float/str, Vec2/Vec3/Color, Entity, Tag, a *Ref, a str Enum, a @record class, "
                            "or list/dict/optional of those.")
            return None
        spec: dict[str, Json] = {"type": typed.type}
        for note in typed.approximations:
            self.approximations.append({"path": module.path, "line": stmt.lineno, "field": f"{info.ref.name}.{name}",
                                        "annotation": ast.unparse(stmt.annotation), "note": note})
        if typed.runtime_only:
            spec["runtime_only"] = True
        options: dict[str, ast.expr] = {}
        default_node: ast.expr | None = None
        if call_fn is not None:
            assert isinstance(value, ast.Call)
            allowed = FIELD_FUNCTIONS[call_fn]
            if len(value.args) > 1:
                self.report(module, value.args[1], "PP4005", f"{call_fn}() takes one positional argument (the default)")
            if value.args:
                default_node = value.args[0]
            for kw in value.keywords:
                if call_fn == "state" and kw.arg == "replicate":
                    self.report(module, kw, "PP4005", "state() has no option 'replicate': behaviors run only "
                                "on the server, so their state isn't replicated",
                                fix="Keep a value clients need in a component field with replicate=.")
                    continue
                if kw.arg is None or kw.arg not in allowed:
                    guess = _close(kw.arg or "", allowed)
                    self.report(module, kw, "PP4005", f"{call_fn}() has no option '{kw.arg}'",
                                fix=f"Did you mean '{guess}'?" if guess else f"Options: {', '.join(allowed)}.")
                    continue
                if kw.arg == "default":
                    default_node = kw.value
                else:
                    options[kw.arg] = kw.value
        else:
            default_node = value
        if isinstance(default_node, ast.Constant) and default_node.value is Ellipsis:
            if module.sdk:
                spec["engine_default"] = True
            else:
                self.report(module, default_node, "PP4002", f"'{name} = ...' is only for SDK stubs",
                            fix="Give the field a real default, or leave it out to make the field required.")
        elif default_node is not None:
            try:
                spec["default"] = self.value(module, default_node)
            except NotStatic:
                spec["default_expr"] = ast.unparse(default_node)
                self.report(module, default_node, "PP4002",
                            f"The default of '{name}' can't be read statically: {ast.unparse(default_node)}",
                            fix="Use a literal, a vec2/vec3/Color/Timer/@record call, an Enum member or a module constant.",
                            severity="warning")
        for key, node in options.items():
            try:
                option = self.value(module, node)
            except NotStatic:
                self.report(module, node, "PP1103", f"{call_fn}({key}=...) must be a literal")
                continue
            if key in ("min", "max") and not (isinstance(option, (int, float)) and not isinstance(option, bool)):
                self.report(module, node, "PP4005", f"{key}= must be a number")
                continue
            if key == "keep" and option not in KEEPS:
                self.report(module, node, "PP4006", f"keep={option!r} is not a lifetime",
                            fix=f"Use one of {', '.join(KEEPS)}.")
                continue
            if key == "keep" and info.kind != "resource":
                self.report(module, node, "PP4006", f"keep= applies to resource fields; '{name}' is on a @{info.kind}",
                            fix="Remove keep=; entities never outlive a scene load.")
                continue
            spec[key] = option
        doc = spec.get("doc") or attr_doc
        if doc is not None:
            spec["doc"] = doc
        spec["annotation"] = ast.unparse(stmt.annotation)
        spec["line"] = stmt.lineno
        if typed.localized:
            spec["_localized"] = typed.localized  # type: ignore[assignment]
        return spec

    def localized_paths(self, cls: ClassV) -> list[str]:
        self.fields(cls)
        return list(self._localized.get(cls, []))

    # ── shapes ──────────────────────────────────────────────────────────────

    def state_shape(self, module: Module, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> dict[str, object]:
        self._shape_module = module
        return self._shapes.function(fn)

    def _function_for_shape(self, expr: ast.expr) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
        value = self.resolve(self._shape_module, expr)
        if isinstance(value, FuncV) and value.module in self.project:
            return self.resolver.func_node(value)
        return None


def _snake(name: str) -> str:
    out = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _union_members(node: ast.expr) -> list[ast.expr]:
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return _union_members(node.left) + _union_members(node.right)
    return [node]


def _attribute_doc(body: list[ast.stmt], index: int) -> str | None:
    if index + 1 < len(body):
        nxt = body[index + 1]
        if isinstance(nxt, ast.Expr) and isinstance(nxt.value, ast.Constant) and isinstance(nxt.value.value, str):
            return " ".join(nxt.value.value.split())
    return None


def _positional(args: list[Json], kwargs: dict[str, Json], names: tuple[str, ...], defaults: tuple[object, ...]) -> Json:
    out: list[Json] = []
    for i, name in enumerate(names):
        if i < len(args):
            value = args[i]
        elif name in kwargs:
            value = kwargs[name]
        elif defaults[i] is not None:
            value = defaults[i]  # type: ignore[assignment]
        else:
            raise NotStatic(f"missing {name}")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise NotStatic(f"{name} is not a number")
        out.append(value)
    return out


def _number(value: Json) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _arithmetic(node: ast.BinOp, left: Json, right: Json, sequence: bool) -> Json:
    """Static arithmetic on numbers, vectors (as lists) times a number, and repetition of a
    list/tuple literal (`sequence`: `(None,) * 9`)."""
    op = node.op
    if _number(left) and _number(right):
        if isinstance(op, ast.Add):
            return left + right  # type: ignore[operator]
        if isinstance(op, ast.Sub):
            return left - right  # type: ignore[operator]
        if isinstance(op, ast.Mult):
            return left * right  # type: ignore[operator]
        if isinstance(op, ast.Div) and right != 0:
            return left / right  # type: ignore[operator]
        if isinstance(op, ast.FloorDiv) and right != 0:
            return left // right  # type: ignore[operator]
        if isinstance(op, ast.Mod) and right != 0:
            return left % right  # type: ignore[operator]
        if isinstance(op, ast.Pow):
            return left ** right  # type: ignore[operator]
    if sequence:
        if isinstance(op, ast.Mult) and isinstance(left, list) and isinstance(right, int) and not isinstance(right, bool):
            return left * right
        raise NotStatic(ast.unparse(node))
    vector_ops = (ast.Mult, ast.Div)
    if isinstance(op, vector_ops) and isinstance(left, list) and _number(right) and all(_number(v) for v in left):
        return [v * right if isinstance(op, ast.Mult) else v / right for v in left]  # type: ignore[operator]
    if isinstance(op, (ast.Add, ast.Sub)) and isinstance(left, list) and isinstance(right, list) \
            and len(left) == len(right) and all(_number(v) for v in left + right):
        return [a + b if isinstance(op, ast.Add) else a - b for a, b in zip(left, right)]  # type: ignore[operator]
    raise NotStatic(ast.unparse(node))


def _hex_rgba(color: str, alpha: float) -> list[Json]:
    digits = color.lstrip("#")
    if len(digits) in (3, 4):
        digits = "".join(c * 2 for c in digits)
    if len(digits) not in (6, 8) or any(c not in "0123456789abcdefABCDEF" for c in digits):
        raise NotStatic(color)
    return [int(digits[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [alpha]


def _project_ref_value(value: ProjectV) -> Json:
    path = value.path
    if path[0] in ("Prefabs", "Scenes", "Placed", "Dialogue", "WorldLayers") and len(path) == 2:
        return path[1]
    if path[0] == "Content" and len(path) == 3:
        return path[2]
    if path[0] == "Text" and len(path) >= 2:
        return ".".join(path[1:])
    if path[0] == "Assets" and len(path) == 3:
        return f"{path[1]}/{path[2]}"
    if path[0] == "Assets" and len(path) == 5 and path[3] == "clips":
        return f"{path[1]}/{path[2]}#{path[4]}"
    raise NotStatic(".".join(path))
