"""Assemble `build/declarations.json` from a project's modules (see declare.py)."""

import ast
from pathlib import Path

from parallax_transpiler.diagnostics import Diagnostic
from parallax_transpiler.extract.declare import (
    ACTION_KINDS, BEHAVIOR_HOOKS, BINDING_CLASSES, BINDING_DEVICES, BUILTIN_PANELS, FORMAT_VERSION, HOOK_MISTAKES,
    KEEPS, KEY_ARGUMENTS, LAYERS, PANEL_COMMANDS, PANEL_SCALES, PLUGINS_OF_CLASS, PLUGINS_OF_MODULE, RUNS_ON,
    SYSTEM_HOOKS, ClassInfo, Extractor, NotStatic, _close, _const, _docstring, _edit_distance, _qualified,
)
from parallax_transpiler.extract.keys import KEY_CODES
from parallax_transpiler.extract.shapes import documented
from parallax_transpiler.extract.resolve import (
    AssignV, AttrV, ClassV, FuncV, ProjectV, TagV, Unknown, _resolve_relative,
)
from parallax_transpiler.extract.sources import DEFAULT_SDK_DIR, Module, load_project_modules, load_sdk_modules
from parallax_transpiler.extract.types import Json


def extract_project(root: Path, sdk_dir: Path = DEFAULT_SDK_DIR) -> dict[str, Json]:
    """The declarations document for the project at `root`. Diagnostics are inside it."""
    diagnostics: list[Diagnostic] = []
    sdk = load_sdk_modules(sdk_dir, diagnostics)
    project = load_project_modules(root, diagnostics)
    builder = _Builder(Extractor(project, sdk))
    document = builder.build()
    all_diagnostics = diagnostics + builder.x.diagnostics
    document["diagnostics"] = [d.to_json() for d in all_diagnostics]
    return document


class _Builder:
    def __init__(self, extractor: Extractor) -> None:
        self.x = extractor
        self.doc: dict[str, dict[str, Json]] = {
            "components": {}, "tags": {}, "resources": {}, "configs": {}, "content": {}, "records": {},
            "enums": {}, "events": {}, "behaviors": {}, "systems": {}, "panels": {}, "action_sets": {},
            "functions": {}, "facts": {}, "features": {},
        }
        self._defined_at: dict[tuple[str, str], str] = {}

    # ── entry ───────────────────────────────────────────────────────────────

    def build(self) -> dict[str, Json]:
        x = self.x
        for module in x.project.values():
            for stmt in module.tree.body:
                if isinstance(stmt, ast.ClassDef):
                    self._class(module, ClassV(module.name, stmt.name))
                elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self._function(module, stmt)
                elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                    self._assignment(module, stmt.targets[0].id, stmt)
        self._scene_commands_in_functions()
        game = self._game()
        return {
            "version": FORMAT_VERSION,
            "game": game,
            **self.doc,
            "engine": self._engine(),
            "modules": self._modules(),
            "project_refs": self._project_refs(),
            "spawns": self._spawns(),
            "approximations": x.approximations,
        }

    def _where(self, module: Module, node: ast.AST) -> dict[str, Json]:
        return {"path": module.path, "line": getattr(node, "lineno", 1)}

    def _register(self, section: str, ident: str, module: Module, node: ast.AST, entry: dict[str, Json]) -> None:
        existing = self._defined_at.get((section, ident))
        if existing is not None:
            self.x.report(module, node, "PP1104", f"{section[:-1].capitalize()} id \"{ident}\" is already declared at {existing}",
                          fix="Ids are global across the game and its features; rename one of them.")
            return
        self._defined_at[(section, ident)] = f"{module.path}:{getattr(node, 'lineno', 1)}"
        self.doc[section][ident] = entry

    # ── classes ─────────────────────────────────────────────────────────────

    def _class(self, module: Module, ref: ClassV) -> None:
        x = self.x
        info = x.class_info(ref)
        base = {"name": ref.name, "module": module.name, "feature": module.feature, **self._where(module, info.node)}
        doc = _docstring(info.node.body)
        if doc is not None:
            base["doc"] = doc
        kind = info.kind
        if kind in ("component", "resource", "config", "content", "event") and info.id is None:
            return
        if kind == "component":
            self._no_methods(info)
            self._register("components", info.id, module, info.node,
                           {**base, "fields": x.fields(ref), "localized": x.localized_paths(ref)})
        elif kind == "resource":
            self._no_methods(info)
            self._resource(info, base)
        elif kind == "config":
            self._register("configs", info.id, module, info.node,
                           {**base, "fields": x.fields(ref), "localized": x.localized_paths(ref)})
        elif kind == "content":
            self._content(info, base)
        elif kind == "record":
            self.doc["records"][_qualified(ref)] = {**base, "fields": x.fields(ref), "localized": x.localized_paths(ref)}
        elif kind == "event":
            self._event(info, base)
        elif kind == "behavior" and info.id is not None:
            self._behavior(info, base)
        elif kind == "system" and info.id is not None:
            self._system(info, base)
        elif kind == "panel" and info.id is not None:
            self._panel(info, base)
        elif kind == "actions":
            self._actions(info, base)
        elif kind == "enum":
            self.doc["enums"][_qualified(ref)] = {**base, "values": x.enum_values(ref)}
        elif kind == "plain":
            self._undecorated(info)

    def _undecorated(self, info: ClassInfo) -> None:
        """A Behavior/System/Panel subclass without its decorator never runs."""
        for sdk_base, decorator in (("Behavior", "behavior"), ("System", "system"), ("Panel", "ui")):
            if self.x.is_subclass(info.ref, "parallax", sdk_base) and info.ref.module not in self.x.sdk:
                used_as_base = any(
                    isinstance(b, ast.Name) and b.id == info.ref.name
                    for m in self.x.project.values() for n in ast.walk(m.tree) if isinstance(n, ast.ClassDef) for b in n.bases)
                if not used_as_base:
                    self.x.report(info.module, info.node, "PP4200",
                                  f"{info.ref.name} subclasses {sdk_base} but has no @{decorator}(...) decorator, so it never runs",
                                  fix=f"Add @{decorator}(\"{_snake_id(info.ref.name)}\").", severity="warning")
                return

    def _no_methods(self, info: ClassInfo) -> None:
        """Components and resources are data only: the game reads them as field objects
        (`entity.get(Hp)`, `ctx.get(Score)`), never as instances, so a method could not be called."""
        for stmt in info.node.body:
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if info.kind == "resource":
                self.x.report(info.module, stmt, "PP4201",
                              f"Resource {info.ref.name} defines method '{stmt.name}'; resources are data only",
                              fix="Move the logic to a behavior or system, or a plain function that takes the resource.")
            else:
                self.x.report(info.module, stmt, "PP4201",
                              f"Component {info.ref.name} defines method '{stmt.name}'; components are data only",
                              fix="Move the logic to a behavior or system, or a plain function that takes the component.")

    def _resource(self, info: ClassInfo, base: dict[str, Json]) -> None:
        keep = "run"
        if "keep" in info.keywords:
            try:
                keep = _const(info.keywords["keep"])
            except NotStatic:
                keep = None
            if keep not in KEEPS:
                self.x.report(info.module, info.keywords["keep"], "PP4006", "@resource keep= must be a lifetime literal",
                              fix=f"Use one of {', '.join(KEEPS)}.")
                keep = "run"
        fields = {}
        for name, spec in self.x.fields(info.ref).items():
            fields[name] = {**spec, "keep": spec.get("keep", keep)}
        self._register("resources", info.id, info.module, info.node,
                       {**base, "keep": keep, "fields": fields, "localized": self.x.localized_paths(info.ref)})

    def _content(self, info: ClassInfo, base: dict[str, Json]) -> None:
        fields = self.x.fields(info.ref)
        entry: dict[str, Json] = {**base, "kind": info.id, "fields": fields, "localized": self.x.localized_paths(info.ref)}
        if "order" in info.keywords:
            try:
                order = _const(info.keywords["order"])
            except NotStatic:
                order = None
            if not isinstance(order, str):
                self.x.report(info.module, info.keywords["order"], "PP1103", "@content order= must be a field name string")
            elif order not in fields:
                guess = _close(order, list(fields))
                self.x.report(info.module, info.keywords["order"], "PP4007", f"order=\"{order}\" names no field of {info.ref.name}",
                              fix=f"Did you mean \"{guess}\"?" if guess else f"Fields: {', '.join(fields)}.")
            elif fields[order]["type"]["kind"] not in ("int", "number"):  # type: ignore[index]
                self.x.report(info.module, info.keywords["order"], "PP4007",
                              f"order=\"{order}\" must name an int or float field", fix="Order by a number field.")
            else:
                entry["order"] = order
        extends = [b for b in self.x.bases(info.ref) if isinstance(b, ClassV) and b.module in self.x.sdk
                   and self.x.class_info(b).kind == "content"]
        if extends:
            entry["extends"] = self.x.class_info(extends[0]).id
        self._register("content", info.id, info.module, info.node, entry)

    def _event(self, info: ClassInfo, base: dict[str, Json]) -> None:
        fields = self.x.fields(info.ref)
        entry: dict[str, Json] = {**base, "fields": fields}
        if "target" in info.keywords:
            try:
                target = _const(info.keywords["target"])
            except NotStatic:
                target = None
            if not isinstance(target, str) or target not in fields:
                self.x.report(info.module, info.keywords["target"], "PP4008",
                              f"target= must name a field of {info.ref.name}",
                              fix=f"Entity fields: {', '.join(n for n, s in fields.items() if s['type'] == {'kind': 'entity'}) or '(none)'}.")
            elif fields[target]["type"] != {"kind": "entity"}:
                self.x.report(info.module, info.keywords["target"], "PP4008",
                              f"target=\"{target}\" must name an Entity field", fix=f"Annotate it `{target}: Entity`.")
            else:
                entry["target"] = target
        self._register("events", info.id, info.module, info.node, entry)

    # ── logic ───────────────────────────────────────────────────────────────

    def _methods(self, info: ClassInfo, hooks: dict[str, int], kind: str) -> tuple[list[str], list[Json]]:
        x = self.x
        found_hooks: list[str] = []
        handlers: list[Json] = []
        called = {n.attr for n in ast.walk(info.node)
                  if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "self"}
        for stmt in info.node.body:
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            handler = self._handler(info, stmt)
            params = len(stmt.args.args) - 1
            if handler is not None:
                handlers.append(handler)
                if params != 2:
                    x.report(info.module, stmt, "PP4212", f"Handler '{stmt.name}' must take (self, ctx, event)",
                             fix=f"def {stmt.name}(self, ctx, event): ...")
                continue
            if stmt.name in hooks:
                found_hooks.append(stmt.name)
                if params != hooks[stmt.name]:
                    signature = "self, ctx" + (", dt" if hooks[stmt.name] == 2 else "")
                    x.report(info.module, stmt, "PP4212", f"Hook '{stmt.name}' must take ({signature})",
                             fix=f"def {stmt.name}({signature}): ...")
                continue
            if stmt.name in called:
                continue
            guess = HOOK_MISTAKES.get(stmt.name.lower())
            if guess is None and len(stmt.name) >= 4:
                close = [h for h in hooks if _edit_distance(stmt.name, h) <= 1]
                guess = close[0] if close else None
            if guess is not None and guess in hooks:
                x.report(info.module, stmt, "PP4210", f"Unknown hook '{stmt.name}' — did you mean '{guess}'?",
                         fix=f"Rename it to '{guess}'. {kind.capitalize()} hooks: {', '.join(hooks)}.")
        return found_hooks, handlers

    def _handler(self, info: ClassInfo, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> dict[str, Json] | None:
        x = self.x
        for decorator in fn.decorator_list:
            if not isinstance(decorator, ast.Call) or x.sdk_function(x.resolve(info.module, decorator.func)) != "on":
                continue
            entry: dict[str, Json] = {"method": fn.name, "line": fn.lineno}
            if not decorator.args:
                x.report(info.module, decorator, "PP1103", "@on needs an event class: @on(Collided)")
                return entry
            event = x.resolve(info.module, decorator.args[0])
            if isinstance(event, ClassV) and x.class_info(event).kind == "event" and x.class_info(event).id is not None:
                entry["event"] = x.class_info(event).id
            else:
                x.report(info.module, decorator.args[0], "PP2064",
                         f"@on({ast.unparse(decorator.args[0])}) does not name an @event class",
                         fix="Pass an event class declared with @event(...), e.g. @on(Collided).")
            for kw in decorator.keywords:
                if kw.arg in ("when", "where"):
                    entry[kw.arg] = True
                elif kw.arg == "always":
                    try:
                        entry["always"] = bool(_const(kw.value))
                    except NotStatic:
                        x.report(info.module, kw.value, "PP1103", "always= must be True or False")
                else:
                    x.report(info.module, kw, "PP4005", f"@on has no option '{kw.arg}'", fix="Options: when, where, always.")
            return entry
        return None

    def _assigned_attributes(self, info: ClassInfo) -> list[tuple[str, ast.AST]]:
        found: list[tuple[str, ast.AST]] = []

        def targets(node: ast.expr) -> list[ast.expr]:
            if isinstance(node, (ast.Tuple, ast.List)):
                return [t for e in node.elts for t in targets(e)]
            return [node]

        for stmt in info.node.body:
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(stmt):
                nodes: list[ast.expr] = []
                if isinstance(node, ast.Assign):
                    nodes = [t for target in node.targets for t in targets(target)]
                elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
                    nodes = [node.target]
                for target in nodes:
                    if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self":
                        found.append((target.attr, target))
        return found

    def _behavior(self, info: ClassInfo, base: dict[str, Json]) -> None:
        x = self.x
        if not x.is_subclass(info.ref, "parallax", "Behavior"):
            x.report(info.module, info.node, "PP4200", f"@behavior class {info.ref.name} must subclass Behavior",
                     fix=f"class {info.ref.name}(Behavior): ...")
        params = x.fields(info.ref, "param")
        state = x.fields(info.ref, "state")
        for stmt in info.node.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) \
                    and stmt.target.id not in params and stmt.target.id not in state:
                x.report(info.module, stmt, "PP4223", f"Behavior field '{stmt.target.id}' must be a param() or state()",
                         fix=f"{stmt.target.id}: {ast.unparse(stmt.annotation)} = param(...)  # or state(...)")
        for name, node in self._assigned_attributes(info):
            if name in params:
                x.report(info.module, node, "PP4222", f"'{name}' is a param, read-only at runtime",
                         fix=f"Declare a state() field for the changing value, seeded from self.{name} in start().")
            elif name not in state:
                x.report(info.module, node, "PP4221", f"Assigning undeclared 'self.{name}'",
                         fix=f"Declare it: {name}: <type> = state(<default>).")
        hooks, handlers = self._methods(info, BEHAVIOR_HOOKS, "behavior")
        entry: dict[str, Json] = {**base, "params": params, "state": state, "hooks": hooks, "handlers": handlers,
                                  "requires": self._component_ids(info, info.keywords.get("requires")),
                                  "when": "when" in info.keywords, "tick": "frame"}
        if "tick" in info.keywords:
            try:
                tick = x.value(info.module, info.keywords["tick"])
            except NotStatic:
                tick = None
            if tick in ("frame", "significance") or (isinstance(tick, (int, float)) and not isinstance(tick, bool) and tick > 0):
                entry["tick"] = tick
            else:
                x.report(info.module, info.keywords["tick"], "PP4005", "tick= must be \"frame\", \"significance\" or a rate in Hz")
        if entry["when"] and not hooks and not handlers:
            x.report(info.module, info.keywords["when"], "PP4230", "when= gates nothing: the behavior has no hooks or handlers",
                     severity="warning", fix="Remove when=, or add the hooks it should gate.")
        self._register("behaviors", info.id, info.module, info.node, entry)

    def _component_ids(self, info: ClassInfo, node: ast.expr | None) -> list[Json]:
        if node is None:
            return []
        if not isinstance(node, (ast.List, ast.Tuple)):
            self.x.report(info.module, node, "PP1103", "requires= must be a list of component classes")
            return []
        ids: list[Json] = []
        for element in node.elts:
            value = self.x.resolve(info.module, element)
            if isinstance(value, ClassV) and self.x.class_info(value).kind == "component" and self.x.class_info(value).id:
                ids.append(self.x.class_info(value).id)
            else:
                self.x.report(info.module, element, "PP2050", f"requires= entry {ast.unparse(element)} is not a component class",
                              fix="List @component classes (or engine components such as Rigidbody).")
        return ids

    def _system(self, info: ClassInfo, base: dict[str, Json]) -> None:
        x = self.x
        if not x.is_subclass(info.ref, "parallax", "System"):
            x.report(info.module, info.node, "PP4200", f"@system class {info.ref.name} must subclass System",
                     fix=f"class {info.ref.name}(System): ...")
        for stmt in info.node.body:
            if isinstance(stmt, ast.AnnAssign):
                x.report(info.module, stmt, "PP4220", f"System {info.ref.name} declares a field; systems have no fields",
                         fix="Keep game-wide state in a @resource and tunables in a @config.")
        for name, node in self._assigned_attributes(info):
            x.report(info.module, node, "PP4220", f"System {info.ref.name} assigns 'self.{name}'; systems have no fields",
                     fix="Keep game-wide state in a @resource (ctx.get(R)) and tunables in a @config.")
        hooks, handlers = self._methods(info, SYSTEM_HOOKS, "system")
        entry: dict[str, Json] = {**base, "hooks": hooks, "handlers": handlers, "when": "when" in info.keywords,
                                  "scenes": self._scenes(info.module, info.keywords.get("scenes")),
                                  "after": [], "runs_while_frozen": False, "runs_on": "server"}
        if "after" in info.keywords:
            entry["after"] = self._system_list(info.module, info.keywords["after"])
        for key, allowed in (("runs_while_frozen", (True, False)), ("runs_on", RUNS_ON)):
            if key in info.keywords:
                try:
                    value = _const(info.keywords[key])
                except NotStatic:
                    value = None
                if value not in allowed:
                    x.report(info.module, info.keywords[key], "PP4005", f"{key}= must be one of {', '.join(map(repr, allowed))}")
                else:
                    entry[key] = value
        if entry["when"] and not hooks and not handlers:
            x.report(info.module, info.keywords["when"], "PP4230", "when= gates nothing: the system has no hooks or handlers",
                     severity="warning", fix="Remove when=, or add the hooks it should gate.")
        self._register("systems", info.id, info.module, info.node, entry)

    def _system_list(self, module: Module, node: ast.expr) -> list[Json]:
        if not isinstance(node, (ast.List, ast.Tuple)):
            self.x.report(module, node, "PP1103", "Expected a list of @system classes")
            return []
        ids: list[Json] = []
        for element in node.elts:
            value = self.x.resolve(module, element)
            if isinstance(value, ClassV) and self.x.class_info(value).kind == "system" and self.x.class_info(value).id:
                ids.append(self.x.class_info(value).id)
            else:
                self.x.report(module, element, "PP2065", f"{ast.unparse(element)} is not a @system class",
                              fix="List classes decorated with @system(...).")
        return ids

    def _scenes(self, module: Module, node: ast.expr | None) -> list[Json]:
        if node is None:
            return []
        if not isinstance(node, (ast.List, ast.Tuple)):
            self.x.report(module, node, "PP1103", "scenes= must be a list of scene refs (Scenes.<id>) or scene tags")
            return []
        out: list[Json] = []
        for element in node.elts:
            value = self.x.resolve(module, element)
            if isinstance(value, ProjectV) and len(value.path) == 2 and value.path[0] == "Scenes":
                out.append({"scene": value.path[1], "line": element.lineno})
            elif isinstance(value, TagV):
                out.append({"tag": value.id, "line": element.lineno})
            else:
                self.x.report(module, element, "PP1102", f"scenes= entry {ast.unparse(element)} is not Scenes.<id> or a tag",
                              fix="Use a scene ref from `project` or a tag declared with tag(\"...\").")
        return out

    # ── UI ──────────────────────────────────────────────────────────────────

    def _panel(self, info: ClassInfo, base: dict[str, Json]) -> None:
        x = self.x
        module = info.module
        if not x.is_subclass(info.ref, "parallax", "Panel"):
            x.report(module, info.node, "PP4200", f"@ui class {info.ref.name} must subclass Panel",
                     fix=f"class {info.ref.name}(Panel): ...")
        entry: dict[str, Json] = {**base, "modal": False, "layer": "hud", "when": False, "delay": 0,
                                  "per_player": x.is_subclass(info.ref, "parallax", "PlayerPanel"),
                                  "scenes": self._scenes(module, info.keywords.get("scenes"))}
        html = info.keywords.get("html")
        try:
            html_value = _const(html) if html is not None else None
        except NotStatic:
            html_value = None
        if not isinstance(html_value, str):
            x.report(module, html or info.decorator or info.node, "PP1103", "@ui needs html=\"ui/<file>.html\" as a string literal",
                     fix=f"@ui(\"{info.id}\", html=\"ui/{info.id}.html\")")
        else:
            entry["html"] = html_value
        for key, allowed in (("modal", (True, False)), ("layer", LAYERS), ("scale", PANEL_SCALES)):
            if key in info.keywords:
                try:
                    value = _const(info.keywords[key])
                except NotStatic:
                    value = None
                if value not in allowed:
                    x.report(module, info.keywords[key], "PP4005", f"{key}= must be one of {', '.join(map(repr, allowed))}")
                else:
                    entry[key] = value
        if "when" in info.keywords:
            entry["when"] = True
        if "delay" in info.keywords:
            try:
                delay = _const(info.keywords["delay"])
                entry["delay"] = delay if isinstance(delay, (int, float)) and not isinstance(delay, bool) else 0
            except NotStatic:
                entry["delay"] = "dynamic"
            if not entry["when"]:
                x.report(module, info.keywords["delay"], "PP4250", "delay= only applies to a when= panel",
                         fix="Remove delay=, or open the panel with when=.")
        openers = [k for k in ("when", "toggle_with", "while_held") if k in info.keywords]
        if len(openers) > 1:
            x.report(module, info.keywords[openers[1]], "PP4250",
                     f"A panel opens one way; this one has {' and '.join(openers)}=",
                     fix="Keep one of when=, toggle_with= or while_held=.")
        for key in ("toggle_with", "while_held"):
            if key in info.keywords:
                ref = self._action_ref(module, info.keywords[key], need_button=True)
                if ref is not None:
                    entry[key] = ref
        actions, dynamic = self._panel_actions(info)
        entry["actions"] = actions
        if dynamic:
            entry["actions_dynamic"] = True
        if entry["when"]:
            for name, action in actions.items():
                if isinstance(action, dict) and action.get("command") == "close_panel":
                    x.report(module, info.node, "PP4250",
                             f"Action '{name}' closes a when= panel; it follows its condition instead",
                             fix="Change the state its when= reads (a function action), or drop the action.")
        entry["state"] = self._panel_state(info)
        self._register("panels", info.id, module, info.node, entry)

    def _class_attribute(self, cls: ClassV, name: str, seen: frozenset[ClassV] = frozenset()) -> tuple[ClassInfo, ast.expr] | None:
        info = self.x.class_info(cls)
        for stmt in info.node.body:
            if isinstance(stmt, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in stmt.targets):
                return info, stmt.value
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.target.id == name and stmt.value:
                return info, stmt.value
        for base in self.x.bases(cls):
            if isinstance(base, ClassV) and base not in seen and base.module not in self.x.sdk:
                found = self._class_attribute(base, name, seen | {cls})
                if found is not None:
                    return found
        return None

    def _panel_actions(self, info: ClassInfo) -> tuple[dict[str, Json], bool]:
        found = self._class_attribute(info.ref, "actions")
        if found is None:
            return {}, False
        owner, node = found
        if not isinstance(node, ast.Dict):
            return {}, True
        actions: dict[str, Json] = {}
        dynamic = False
        for key, value in zip(node.keys, node.values):
            if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
                dynamic = True
                continue
            actions[key.value] = self._panel_action(owner.module, value)
        return actions, dynamic

    def _panel_action(self, module: Module, node: ast.expr) -> dict[str, Json]:
        x = self.x
        if isinstance(node, ast.Call):
            command = x.sdk_function(x.resolve(module, node.func))
            if command in PANEL_COMMANDS:
                entry: dict[str, Json] = {"kind": "command", "command": command, "line": node.lineno}
                if command == "open_panel" and node.args:
                    target = x.resolve(module, node.args[0])
                    if isinstance(target, ClassV) and target.module in x.sdk and target.name in BUILTIN_PANELS:
                        entry["builtin"] = target.name
                    elif isinstance(target, ClassV) and x.class_info(target).kind == "panel" and x.class_info(target).id:
                        entry["panel"] = x.class_info(target).id
                    else:
                        x.report(module, node.args[0], "PP2054", f"open_panel({ast.unparse(node.args[0])}) is not a @ui panel")
                if command == "load_scene" and node.args:
                    target = x.resolve(module, node.args[0])
                    if isinstance(target, ProjectV) and len(target.path) == 2 and target.path[0] == "Scenes":
                        entry["scene"] = target.path[1]
                    else:
                        x.report(module, node.args[0], "PP1102", "load_scene needs a scene ref: load_scene(Scenes.<id>)")
                for kw in node.keywords:
                    if kw.arg == "reset":
                        x.report(module, kw.value, "PP1103", f"{command}(reset=...) was renamed",
                                 fix="Write new_run=True instead of reset=\"run\".")
                    elif kw.arg == "new_run":
                        try:
                            new_run = _const(kw.value)
                        except NotStatic:
                            new_run = None
                        if isinstance(new_run, bool):
                            entry["new_run"] = new_run
                        else:
                            x.report(module, kw.value, "PP1103", "new_run= must be True or False")
                return entry
            return {"kind": "unknown", "line": node.lineno, "source": ast.unparse(node)}
        if isinstance(node, ast.Lambda):
            return {"kind": "function", "name": "<lambda>", "params": [a.arg for a in node.args.args[1:]],
                    "param_types": {}, "line": node.lineno}
        value = x.resolve(module, node)
        if isinstance(value, AssignV):
            # A shared command: `to_title = load_scene(Scenes.title, reset="run")`.
            entry = self._panel_action(x.modules[value.module], x.resolver.assigned(value))
            return {**entry, "line": node.lineno}
        if isinstance(value, ClassV):
            info = x.class_info(value)
            if info.kind == "event" and info.id:
                return {"kind": "event", "event": info.id, "line": node.lineno}
        if isinstance(value, FuncV) and value.module in x.project:
            fn = x.resolver.func_node(value)
            fn_module = x.modules[value.module]
            entry = {"kind": "function", "name": _qualified(value), "line": node.lineno, "params": [], "param_types": {}}
            for decorator in fn.decorator_list:
                call = decorator.func if isinstance(decorator, ast.Call) else decorator
                name = x.sdk_function(x.resolve(fn_module, call))
                if name == "rpc":
                    entry["kind"] = "rpc"
                if name == "action" and isinstance(decorator, ast.Call) and any(k.arg == "when" for k in decorator.keywords):
                    entry["when"] = True
            params: list[Json] = []
            types: dict[str, Json] = {}
            for arg in fn.args.args[1:] + fn.args.kwonlyargs:
                if arg.annotation is not None:
                    try:
                        typed = x.field_type(fn_module, arg.annotation)
                    except NotStatic:
                        continue
                    if typed.runtime_only:
                        continue  # injected (the clicking Player)
                    types[arg.arg] = typed.type
                params.append(arg.arg)
            defaults = len(fn.args.defaults)
            entry["required"] = [a.arg for a in fn.args.args[1:len(fn.args.args) - defaults] if a.arg in params]
            entry["params"] = params
            entry["param_types"] = types
            return entry
        x.report(module, node, "PP4251", f"Panel action {ast.unparse(node)} is not a command, function, @rpc or event class",
                 fix="Use close_panel()/open_panel(P)/load_scene(S)/reload_scene(), a function, an @rpc or an @event class.")
        return {"kind": "unknown", "line": node.lineno, "source": ast.unparse(node)}

    def _panel_state(self, info: ClassInfo) -> Json:
        """The shape of the panel's state(): its own (or a project base's) state(), else the
        built-in panel's it subclasses (an SDK panel whose docstring lists its keys, like the
        HUD kit's), else none. A state() that only returns `super().state(...)` is the
        built-in's too."""
        found = None
        builtin: Json = None
        chain, seen = [info.ref], set()
        while chain:
            cls = chain.pop(0)
            if cls in seen:
                continue
            seen.add(cls)
            node = self.x.resolver.class_node(cls)
            if cls.module in self.x.sdk:
                builtin = documented(ast.get_docstring(node))
                if builtin is not None:
                    break
                continue
            if cls.module not in self.x.project:
                continue
            if found is None:
                for stmt in node.body:
                    if isinstance(stmt, ast.FunctionDef) and stmt.name == "state":
                        found = (self.x.modules[cls.module], stmt)
                        break
            chain.extend(b for b in self.x.bases(cls) if isinstance(b, ClassV))
        if found is None:
            return builtin if builtin is not None else {"kind": "object", "keys": {}, "open": False}
        if builtin is not None and _only_super_state(found[1]):
            return builtin
        shape = self.x.state_shape(*found)
        return shape if shape.get("kind") == "object" else None

    # ── actions ─────────────────────────────────────────────────────────────

    def _actions(self, info: ClassInfo, base: dict[str, Json]) -> None:
        x = self.x
        if info.ref.module in x.sdk:
            return
        entry: dict[str, Json] = {**base, "actions": {}, "priority": 0, "scenes": [], "active_when": False}
        chain = [info]
        for b in x.bases(info.ref):
            if isinstance(b, ClassV) and b.module in x.project and x.class_info(b).kind == "actions":
                parent = self.doc["action_sets"].get(_qualified(b))
                if parent is None:
                    self._actions(x.class_info(b), {"name": b.name, "module": b.module, "feature": x.modules[b.module].feature,
                                                     **self._where(x.modules[b.module], x.class_info(b).node)})
                    parent = self.doc["action_sets"][_qualified(b)]
                entry["actions"] = dict(parent["actions"])  # type: ignore[arg-type]
                entry["scenes"] = parent["scenes"]
                entry["priority"] = parent["priority"]
                entry["active_when"] = parent["active_when"]
        for stmt in info.node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == "active_when":
                entry["active_when"] = True
                continue
            if not (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)):
                continue
            name = stmt.targets[0].id
            if name == "scenes":
                entry["scenes"] = self._scenes(info.module, stmt.value)
            elif name == "priority":
                try:
                    entry["priority"] = _const(stmt.value)
                except NotStatic:
                    x.report(info.module, stmt.value, "PP1103", "priority must be an int literal")
            elif name == "active_when":
                entry["active_when"] = True
            elif isinstance(stmt.value, ast.Call):
                action = self._action(info.module, name, stmt.value)
                if action is not None:
                    entry["actions"][name] = action  # type: ignore[index]
        self.doc["action_sets"][_qualified(info.ref)] = entry

    def _action(self, module: Module, name: str, call: ast.Call) -> dict[str, Json] | None:
        x = self.x
        kind = x.sdk_function(x.resolve(module, call.func))
        if kind not in ACTION_KINDS:
            return None
        bindings: dict[str, Json] = {}
        for kw in call.keywords:
            if kw.arg is None or kw.arg not in BINDING_DEVICES[kind]:
                x.report(module, kw, "PP4005", f"{kind}() has no option '{kw.arg}'",
                         fix=f"Options: {', '.join(BINDING_DEVICES[kind])}.")
                continue
            bindings[kw.arg] = self._binding(module, kw.arg, kw.value)
        return {"kind": kind, "bindings": bindings, "line": call.lineno}

    def _binding(self, module: Module, device: str, node: ast.expr) -> Json:
        x = self.x
        if device in ("repeat", "touch_labels"):
            try:
                return x.value(module, node)
            except NotStatic:
                x.report(module, node, "PP1103", f"{device}= must be a literal")
                return None
        if isinstance(node, ast.Constant) and isinstance(node.value, str) or isinstance(node, (ast.Tuple, ast.List)):
            elements = node.elts if isinstance(node, (ast.Tuple, ast.List)) else [node]
            keys: list[Json] = []
            for element in elements:
                if isinstance(element, ast.Constant) and element.value is None:
                    keys.append(None)
                    continue
                if not (isinstance(element, ast.Constant) and isinstance(element.value, str)):
                    keys.append(self._binding(module, device, element))
                    continue
                if device not in KEY_ARGUMENTS:
                    x.report(module, element, "PP4241", f"{device}= takes {device}.<NAME> constants, not \"{element.value}\"",
                             fix=f"Use {device}.{element.value.upper()} or another constant of `{device}`.")
                elif element.value == "Escape":
                    # The browser releases the cursor lock on Escape, so the game never sees it reliably.
                    x.report(module, element, "PP4242", "Escape can't be bound: the browser takes it to release the cursor lock",
                             fix="Use \"KeyP\" for pause and menus.")
                elif element.value not in KEY_CODES:
                    guess = _close(element.value, sorted(KEY_CODES))
                    x.report(module, element, "PP4240", f"Unknown key \"{element.value}\"",
                             fix=f"Did you mean \"{guess}\"?" if guess else "Use a KeyboardEvent.code name: \"KeyA\", \"Space\", \"ArrowUp\", \"Digit1\".")
                keys.append(element.value)
            return keys
        self._check_binding_expr(module, node)
        return {"expr": ast.unparse(node)}

    def _check_binding_expr(self, module: Module, node: ast.expr) -> None:
        x = self.x
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            self._check_binding_expr(module, node.left)
            self._check_binding_expr(module, node.right)
            return
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                for element in (kw.value.elts if isinstance(kw.value, (ast.Tuple, ast.List)) else [kw.value]):
                    if not (isinstance(element, ast.Constant) and isinstance(element.value, str) and kw.arg in ("up", "down", "left", "right")):
                        continue
                    if element.value == "Escape":
                        x.report(module, element, "PP4242", "Escape can't be bound: the browser takes it to release the cursor lock",
                                 fix="Use \"KeyP\" for pause and menus.")
                    elif element.value not in KEY_CODES:
                        x.report(module, element, "PP4240", f"Unknown key \"{element.value}\"")
            return
        value = x.resolve(module, node)
        if isinstance(value, AttrV) and value.owner.module == "parallax" and value.owner.name in BINDING_CLASSES:
            members = {s.target.id for s in x.resolver.class_node(value.owner).body
                       if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name)}
            members |= {s.name for s in x.resolver.class_node(value.owner).body if isinstance(s, ast.FunctionDef)}
            if value.name not in members:
                guess = _close(value.name, sorted(members))
                x.report(module, node, "PP4241", f"{value.owner.name}.{value.name} is not a binding",
                         fix=f"Did you mean {value.owner.name}.{guess}?" if guess else f"Known: {', '.join(sorted(members))}.")
        elif isinstance(value, Unknown):
            x.report(module, node, "PP1102", f"Can't resolve binding {ast.unparse(node)}: {value.reason}")

    def _action_ref(self, module: Module, node: ast.expr, need_button: bool) -> Json:
        x = self.x
        value = x.resolve(module, node)
        if not (isinstance(value, AttrV) and x.class_info(value.owner).kind == "actions"):
            x.report(module, node, "PP1102", f"{ast.unparse(node)} is not an action (Controls.<action>)")
            return None
        set_name = _qualified(value.owner)
        if set_name not in self.doc["action_sets"]:
            self._actions(x.class_info(value.owner), {"name": value.owner.name, "module": value.owner.module,
                                                      "feature": x.modules[value.owner.module].feature,
                                                      **self._where(x.modules[value.owner.module], x.class_info(value.owner).node)})
        actions = self.doc["action_sets"][set_name]["actions"]  # type: ignore[index]
        if value.name not in actions:  # type: ignore[operator]
            x.report(module, node, "PP2071", f"{value.owner.name} has no action '{value.name}'",
                     fix=f"Actions: {', '.join(actions) or '(none)'}.")  # type: ignore[arg-type]
            return None
        if need_button and actions[value.name]["kind"] != "button":  # type: ignore[index]
            x.report(module, node, "PP4252", f"{value.owner.name}.{value.name} is not a button",
                     fix="toggle_with= and while_held= take a button() action.")
        return {"action_set": set_name, "action": value.name}

    # ── functions, facts, features, game ───────────────────────────────────

    def _function(self, module: Module, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        x = self.x
        for decorator in fn.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            name = x.sdk_function(x.resolve(module, call.func if call else decorator))
            if name not in ("rpc", "quest_verb", "dialogue_command", "migration", "action"):
                continue
            entry: dict[str, Json] = {"kind": name, "name": fn.name, "module": module.name, **self._where(module, fn)}
            if call is not None:
                if call.args:
                    try:
                        entry["id"] = _const(call.args[0])
                    except NotStatic:
                        x.report(module, call.args[0], "PP1103", f"@{name} id must be a string literal")
                for kw in call.keywords:
                    if kw.arg in ("from_version", "to_version", "rate_limit"):
                        try:
                            entry[kw.arg] = _const(kw.value)
                        except NotStatic:
                            x.report(module, kw.value, "PP1103", f"{kw.arg}= must be a literal")
                    elif kw.arg == "target" and name == "quest_verb":
                        try:
                            entry["target"] = x.field_type(module, kw.value).type
                        except NotStatic as error:
                            x.report(module, kw.value, "PP4001", f"quest_verb target type: {error}")
                    elif kw.arg == "args" and name == "quest_verb" and isinstance(kw.value, ast.Dict):
                        args: dict[str, Json] = {}
                        for key, value in zip(kw.value.keys, kw.value.values):
                            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                                try:
                                    args[key.value] = {"type": x.field_type(module, value).type}
                                except NotStatic as error:
                                    x.report(module, value, "PP4001", f"quest_verb arg '{key.value}': {error}")
                        entry["args"] = args
                    elif kw.arg == "when" and name == "action":
                        entry["when"] = True
            self.doc["functions"][f"{module.name}.{fn.name}"] = entry

    def _assignment(self, module: Module, name: str, stmt: ast.Assign) -> None:
        x = self.x
        value = stmt.value
        if not isinstance(value, ast.Call):
            return
        fn = x.sdk_function(x.resolve(module, value.func))
        if fn == "tag":
            ident = value.args[0] if value.args else None
            if not (isinstance(ident, ast.Constant) and isinstance(ident.value, str)):
                x.report(module, value, "PP1103", "tag() needs its id as a string literal: tag(\"enemy\")")
                return
            self._register("tags", ident.value, module, stmt,
                           {"name": name, "module": module.name, "feature": module.feature, **self._where(module, stmt)})
        elif fn == "fact":
            try:
                key = _const(value.args[0]) if value.args else None
                default = x.value(module, value.args[1]) if len(value.args) > 1 else None
            except NotStatic:
                x.report(module, value, "PP1103", "fact(key, default) takes literals")
                return
            if isinstance(key, str):
                self._register("facts", key, module, stmt, {"name": name, "module": module.name, "default": default,
                                                             **self._where(module, stmt)})
        elif x.sdk_class(x.resolve(module, value.func)) == "Feature":
            self._feature(module, name, value)

    def _feature(self, module: Module, name: str, call: ast.Call) -> None:
        x = self.x
        ident = call.args[0] if call.args else None
        if not (isinstance(ident, ast.Constant) and isinstance(ident.value, str)):
            x.report(module, call, "PP1103", "Feature() needs its id as a string literal")
            return
        entry: dict[str, Json] = {"variable": f"{module.name}.{name}", "folder": module.feature,
                                  **self._where(module, call), "requires": [], "systems": [], "scenes": []}
        if module.feature is not None and module.feature != ident.value:
            x.report(module, ident, "PP1105", f"Feature \"{ident.value}\" lives in features/{module.feature}/",
                     fix=f"A feature's id is its folder name: Feature(\"{module.feature}\", ...).")
        for kw in call.keywords:
            if kw.arg == "requires":
                try:
                    requires = x.value(module, kw.value)
                except NotStatic:
                    requires = None
                if not isinstance(requires, list) or not all(isinstance(r, str) for r in requires):
                    x.report(module, kw.value, "PP1103", "requires= must be a list of feature id strings")
                else:
                    entry["requires"] = requires
            elif kw.arg == "systems":
                entry["systems"] = self._system_list(module, kw.value)
            elif kw.arg == "scenes":
                entry["scenes"] = self._scenes(module, kw.value)
            elif kw.arg == "doc":
                try:
                    entry["doc"] = _const(kw.value)
                except NotStatic:
                    pass
            else:
                x.report(module, kw, "PP4005", f"Feature() has no option '{kw.arg}'",
                         fix="Options: requires, systems, scenes, doc. A feature's components, content and panels are "
                             "found from its folder.")
        self._register("features", ident.value, module, call, entry)

    def _game(self) -> Json:
        x = self.x
        module = x.project.get("game.main")
        if module is None:
            self.x.diagnostics.append(_project_diagnostic("PP1101", "No game/main.py", "game/main.py",
                                                          "Create game/main.py with `game = Game(...)`."))
            return None
        call = None
        for stmt in module.tree.body:
            if isinstance(stmt, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "game" for t in stmt.targets) \
                    and isinstance(stmt.value, ast.Call) and x.sdk_class(x.resolve(module, stmt.value.func)) == "Game":
                call = stmt.value
        if call is None:
            self.x.diagnostics.append(_project_diagnostic("PP1101", "game/main.py has no `game = Game(...)`", module.path,
                                                          "Declare the game: game = Game(id=..., title=..., ...)."))
            return None
        game: dict[str, Json] = {**self._where(module, call), "plugins": [], "features": [], "systems": [],
                                 "languages": ["en"], "save_version": 1}
        for kw in call.keywords:
            key = kw.arg
            if key in ("id", "title", "sdk", "mode", "languages", "save_version", "pointer_lock"):
                try:
                    game[key] = x.value(module, kw.value)
                except NotStatic:
                    x.report(module, kw.value, "PP1103", f"Game({key}=...) must be a literal")
            elif key == "start_scene":
                value = x.resolve(module, kw.value)
                if isinstance(value, ProjectV) and len(value.path) == 2 and value.path[0] == "Scenes":
                    game["start_scene"] = value.path[1]
                else:
                    x.report(module, kw.value, "PP1102", "start_scene= must be Scenes.<id>")
            elif key == "systems":
                game["systems"] = self._system_list(module, kw.value)
            elif key == "plugins":
                game["plugins"] = self._plugins(module, kw.value)
            elif key == "features":
                game["features"] = self._feature_list(module, kw.value)
            elif key == "cursor":
                pass  # Cursor(...): a runtime value (the cursor's look), checked when the game starts
            else:
                x.report(module, kw, "PP4005", f"Game() has no option '{key}'",
                         fix="Options: id, title, sdk, start_scene, mode, plugins, features, systems, languages, save_version, cursor, pointer_lock.")
        for required in ("id", "title", "sdk", "start_scene", "mode"):
            if required not in game:
                x.report(module, call, "PP1102", f"Game() is missing {required}=")
        if game.get("mode") not in (None, "2d", "3d"):
            x.report(module, call, "PP4005", "Game(mode=...) must be \"2d\" or \"3d\"")
        return game

    def _plugins(self, module: Module, node: ast.expr) -> list[Json]:
        x = self.x
        if not isinstance(node, (ast.List, ast.Tuple)):
            x.report(module, node, "PP1103", "plugins= must be a list of plugin calls")
            return []
        plugins: list[Json] = []
        for element in node.elts:
            fn = x.resolve(module, element.func) if isinstance(element, ast.Call) else None
            if not (isinstance(element, ast.Call) and isinstance(fn, FuncV) and fn.module == "parallax.plugins"):
                x.report(module, element, "PP1102", f"{ast.unparse(element)} is not a plugin from parallax.plugins",
                         fix="Call a plugin constructor: physics2d(), combat(), ...")
                continue
            options = {kw.arg: self._describe(module, kw.value) for kw in element.keywords if kw.arg}
            plugins.append({"id": fn.name, "options": options, "line": element.lineno})
        return plugins

    def _feature_list(self, module: Module, node: ast.expr) -> list[Json]:
        x = self.x
        if not isinstance(node, (ast.List, ast.Tuple)):
            x.report(module, node, "PP1103", "features= must be a list of Feature variables")
            return []
        out: list[Json] = []
        for element in node.elts:
            value = x.resolve(module, element)
            if isinstance(value, AssignV):
                assigned = x.resolver.assigned(value)
                if isinstance(assigned, ast.Call) and x.sdk_class(x.resolve(x.modules[value.module], assigned.func)) == "Feature" \
                        and assigned.args and isinstance(assigned.args[0], ast.Constant):
                    out.append(assigned.args[0].value)
                    continue
            x.report(module, element, "PP1102", f"{ast.unparse(element)} is not a Feature(...)",
                     fix="Import the feature variable from features/<f>/feature.py.")
        return out

    def _describe(self, module: Module, node: ast.expr) -> Json:
        """A plugin option as data: literals as JSON, references by what they name."""
        x = self.x
        try:
            return x.value(module, node)
        except NotStatic:
            pass
        if isinstance(node, (ast.List, ast.Tuple)):
            return [self._describe(module, e) for e in node.elts]
        value = x.resolve(module, node) if isinstance(node, (ast.Name, ast.Attribute)) else None
        if isinstance(value, ProjectV):
            return {"project": list(value.path)}
        if isinstance(value, ClassV):
            info = x.class_info(value)
            return {"class": _qualified(value), "kind": info.kind, **({"id": info.id} if info.id else {})}
        if isinstance(value, FuncV):
            return {"function": _qualified(value)}
        return {"expr": ast.unparse(node)}

    # ── engine, modules, project refs ───────────────────────────────────────

    def _engine(self) -> Json:
        x = self.x
        engine: dict[str, dict[str, Json]] = {"components": {}, "events": {}, "content": {}, "resources": {}, "records": {}}
        for module in x.sdk.values():
            plugins = PLUGINS_OF_MODULE.get(module.name)
            if plugins is None:
                continue
            for stmt in module.tree.body:
                if not isinstance(stmt, ast.ClassDef):
                    continue
                ref = ClassV(module.name, stmt.name)
                info = x.class_info(ref)
                provided_by = PLUGINS_OF_CLASS.get((module.name, stmt.name), plugins)
                entry: dict[str, Json] = {"name": stmt.name, "module": module.name, "plugins": list(provided_by)}
                if info.kind == "component" and info.id:
                    engine["components"][info.id] = {**entry, "fields": x.fields(ref)}
                elif info.kind == "event" and info.id:
                    target = info.keywords.get("target")
                    engine["events"][info.id] = {**entry, "fields": x.fields(ref),
                                                 **({"target": target.value} if isinstance(target, ast.Constant) else {})}
                elif info.kind == "content" and info.id:
                    engine["content"][info.id] = {**entry, "fields": x.fields(ref), "localized": x.localized_paths(ref)}
                elif info.kind == "resource" and info.id:
                    engine["resources"][info.id] = {**entry, "fields": x.fields(ref)}
                elif info.kind == "record":
                    engine["records"][_qualified(ref)] = {**entry, "fields": x.fields(ref)}
        return engine

    def _modules(self) -> Json:
        """Each module's project-internal imports (for feature boundaries)."""
        out: dict[str, Json] = {}
        project_tops = {name.split(".")[0] for name in self.x.project}
        for module in self.x.project.values():
            imports: list[Json] = []
            for node in ast.walk(module.tree):
                targets: list[str] = []
                if isinstance(node, ast.Import):
                    targets = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    source = node.module or ""
                    if node.level:
                        source = _resolve_relative(module, node.level, node.module)
                    targets = [f"{source}.{a.name}" if f"{source}.{a.name}" in self.x.project else source for a in node.names]
                for target in dict.fromkeys(targets):
                    if target.split(".")[0] in project_tops:
                        imports.append({"module": target, "line": node.lineno})
            out[module.name] = {"path": module.path, "feature": module.feature, "imports": imports}
        return out

    def _scene_commands_in_functions(self) -> None:
        """`load_scene(...)` / `reload_scene(...)` are panel-action values (in an `actions`
        dict, or a module-level shared command). Inside a function — `return load_scene(...)`
        from a function action included — code loads scenes with `ctx.scenes.load/reload`."""
        x = self.x
        for module in x.project.values():
            seen: set[int] = set()
            for fn in ast.walk(module.tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                    continue
                for node in ast.walk(fn):
                    if not isinstance(node, ast.Call) or id(node) in seen:
                        continue
                    name = node.func.id if isinstance(node.func, ast.Name) else (
                        node.func.attr if isinstance(node.func, ast.Attribute) else None)
                    if name not in ("load_scene", "reload_scene"):
                        continue
                    seen.add(id(node))
                    if x.sdk_function(x.resolve(module, node.func)) != name:
                        continue
                    method = "load" if name == "load_scene" else "reload"
                    x.report(module, node, "PP3427",
                             f"{name}(...) inside a function: it is a panel-action value, not a way to load a scene from code",
                             fix=f"Call ctx.scenes.{method}(...) in the function (same arguments) and return nothing; "
                                 f"keep {name}(...) only as a value in a panel's actions dict.")

    def _project_refs(self) -> list[Json]:
        refs: list[Json] = []
        for module in self.x.project.values():
            uses_project = any(isinstance(n, (ast.Import, ast.ImportFrom)) and (
                (isinstance(n, ast.ImportFrom) and n.module == "project")
                or (isinstance(n, ast.Import) and any(a.name == "project" for a in n.names))) for n in module.tree.body)
            if not uses_project:
                continue
            inner = {id(n.value) for n in ast.walk(module.tree) if isinstance(n, ast.Attribute)}
            for node in ast.walk(module.tree):
                if isinstance(node, ast.Attribute) and id(node) not in inner:
                    value = self.x.resolve(module, node)
                    if isinstance(value, ProjectV) and len(value.path) >= 2:
                        refs.append({"ref": list(value.path), "path": module.path, "line": node.lineno,
                                     "column": node.col_offset})
        return refs


    def _spawns(self) -> list[Json]:
        """`ctx.world.spawn(Prefabs.x, components=[...], params={...})` call sites, so the
        checker can count spawn-supplied components toward behavior `requires`."""
        x = self.x
        sites: list[Json] = []
        for module in x.project.values():
            for node in ast.walk(module.tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "spawn"
                        and node.args):
                    continue
                prefab = x.resolve(module, node.args[0]) if isinstance(node.args[0], (ast.Name, ast.Attribute)) else None
                static = isinstance(prefab, ProjectV) and len(prefab.path) == 2 and prefab.path[0] == "Prefabs"
                # A prefab chosen at runtime (from content, a param…) is a dynamic site: prefab None.
                site: dict[str, Json] = {"prefab": prefab.path[1] if static else None, "path": module.path, "line": node.lineno,
                                         "components": [], "params": []}
                for kw in node.keywords:
                    if kw.arg == "components":
                        site["components"] = self._spawned_components(module, kw.value)
                    elif kw.arg == "params":
                        site["params"] = ([k.value for k in kw.value.keys if isinstance(k, ast.Constant)]
                                          if isinstance(kw.value, ast.Dict) and all(isinstance(k, ast.Constant) for k in kw.value.keys)
                                          else None)
                sites.append(site)
        return sites

    def _spawned_components(self, module: Module, node: ast.expr) -> Json:
        """Component ids passed to spawn(components=...), or None when not static."""
        if not isinstance(node, (ast.List, ast.Tuple)):
            return None
        ids: list[Json] = []
        for element in node.elts:
            fn = self.x.resolve(module, element.func) if isinstance(element, ast.Call) else None
            if not (isinstance(fn, ClassV) and self.x.class_info(fn).kind == "component" and self.x.class_info(fn).id):
                return None
            ids.append(self.x.class_info(fn).id)
        return ids


def _snake_id(name: str) -> str:
    out = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _project_diagnostic(code: str, message: str, path: str, fix: str) -> Diagnostic:
    return Diagnostic(code=code, message=message, path=path, line=1, column=0, fix=fix)


def _only_super_state(fn: ast.FunctionDef) -> bool:
    """`def state(self, ctx, ...): return super().state(...)`, docstring aside."""
    body = [stmt for stmt in fn.body if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant))]
    if len(body) != 1 or not isinstance(body[0], ast.Return):
        return False
    call = body[0].value
    return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == "state"
            and isinstance(call.func.value, ast.Call) and isinstance(call.func.value.func, ast.Name)
            and call.func.value.func.id == "super")

