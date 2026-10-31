#!/usr/bin/env python3
"""Generate the diagnostic-code catalog: docs/errors/catalog.json and docs/errors/README.md.

Every error and warning the engine raises carries a code (`PP2041`) and prints a docs link
(`https://parallaxpro.ai/docs/engine/errors/PP2041`). This script finds every code that the
engine's sources raise and records, for each one, what can be read statically:

  - the range it belongs to (the thousands table in packages/runtime/DIAGNOSTICS.md)
  - the area that raises it (derived from the file path, the same way
    packages/runtime/src/diagnostics.test.ts files codes) and the DIAGNOSTICS.md area
    blocks that list it
  - the shared meaning, for codes several areas raise on purpose
  - notes from the code tables in packages/*/README.md and DIAGNOSTICS.md, and from
    `PPxxxx  meaning` lines in source comments
  - the message and fix texts at each raise site, with interpolations written `{name}`
  - the source files that raise it

Sources scanned: packages/**/*.{ts,tsx,mjs,js,py}, without tests, fixtures, node_modules and the
packages that are not part of the public release (EXCLUDED_PACKAGES).

    python3 tools/gen_error_catalog.py           # write the catalog
    python3 tools/gen_error_catalog.py --check   # exit 1 if the committed catalog is stale

The output is deterministic (sorted, no timestamps), so --check is an exact comparison.
Standard library only.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ROOT / "packages"
OUT_DIR = ROOT / "docs" / "errors"
DIAGNOSTICS_MD = PACKAGES / "runtime" / "DIAGNOSTICS.md"
DOCS_BASE = "https://parallaxpro.ai/docs/engine/errors/"

CODE_RE = re.compile(r"^PP\d{4}$")
SOURCE_SUFFIXES = (".ts", ".tsx", ".mjs", ".js", ".py")
# Internal tools left out of the public export.
EXCLUDED_PACKAGES = {"migrate"}

# The thousands DIAGNOSTICS.md does not list: the transpiler's codes (packages/transpiler).
EXTRA_RANGES = {
    "PP1xxx": "data files that don't parse or don't have the right shape (resource loader)",
    "PP2xxx": "project data that is well formed but wrong: names, references, assets, panels (also `parallax check`)",
    "PP3xxx": "runtime API misuse and plugin data errors, one hundred (or a decade) per plugin",
    "PP4xxx": "declarations and types: `@component` / `@resource` / field schemas, actions, net declarations",
    "PP5xxx": "values and conversions in core",
    "PP6xxx": "Parallax Python: syntax, unsupported constructs and sandbox rules (the transpiler)",
    "PP7xxx": "later gameplay plugins (economy, cinematics, vehicles, combat depth, grid, city)",
    "PP9xxx": "engine-internal and platform failures: boot, jobs, bundles, net transport",
}

# packages/runtime/src/diagnostics.test.ts: plugin areas by directory / api / check module name.
ALIASES = {
    "physics": "physics", "physics2d": "physics", "physics3d": "physics", "story": "story",
    "animation": "visuals", "model_sockets": "visuals", "model": "visuals", "visuals": "visuals",
    "models": "visuals", "render3d": "visuals", "action_input": "input", "character": "characters",
    "screens": "screens",
}
CHECK_SPANS = {
    "check:nature": ["water", "weather", "environment", "foliage", "wind"],
    "check:terrain": ["terrain", "foliage", "wind"],
    "check:physics": ["physics", "destruction"],
    "check:vehicle_combat": ["vehicles", "combat"],
    "check:characters": ["characters", "viewmodel"],
    "check:niche": ["screens", "softbody", "payments", "chat", "voice"],
}


# ── Source files ─────────────────────────────────────────────────────────────────


def is_source(rel: str) -> bool:
    parts = rel.split("/")
    name = parts[-1]
    if parts[0] in EXCLUDED_PACKAGES:
        return False
    if not name.endswith(SOURCE_SUFFIXES) or name.endswith(".d.ts"):
        return False
    if any(p in ("node_modules", "tests", "test-results", "dist", "fixtures") for p in parts[:-1]):
        return False
    if ".test." in name or name.startswith("test_") or "fixture" in name:
        return False
    return True


def source_files() -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(PACKAGES):
        dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".git", "__pycache__"))
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), PACKAGES).replace(os.sep, "/")
            if is_source(rel):
                out.append(rel)
    return sorted(out)


def plugin_dirs() -> set[str]:
    base = PACKAGES / "runtime" / "src" / "function" / "plugins"
    return {p.name for p in base.iterdir() if p.is_dir()} if base.is_dir() else set()


def area_of(rel: str, plugins: set[str]) -> str:
    """The area a file's codes belong to (mirrors diagnostics.test.ts; other packages by name)."""
    def plugin(name: str) -> str | None:
        return ALIASES.get(name, name) if (name in plugins or name in ALIASES) else None

    m = re.match(r"^runtime/src/function/plugins/([^/]+)/", rel)
    if m:
        return plugin(m[1]) or m[1]
    m = re.match(r"^runtime/src/api/([^/.]+)\.ts$", rel)
    if m:
        return plugin(m[1]) or "core"
    m = re.match(r"^check/src/([a-z0-9]+(?:_[a-z0-9]+)*)_checks\.ts$", rel)
    if m:
        name = plugin(m[1]) or m[1]
        return f"check:{name}" if f"check:{name}" in CHECK_SPANS else (plugin(m[1]) or "core")
    if rel.startswith("runtime/src/platform/browser/ui/"):
        return "ui"
    if rel.startswith("runtime/src/resource/models/"):
        return "visuals"
    if rel.startswith("test/"):
        return "test"
    if rel.startswith(("runtime/", "check/")):
        return "core"
    return rel.split("/")[0]  # transpiler, cli, editor, migrate, server


def merge_spans(areas: set[str]) -> list[str]:
    out = set(areas)
    for check, spanned in CHECK_SPANS.items():
        if check in out and any(p in out for p in spanned):
            out.discard(check)
    return sorted(a.removeprefix("check:") for a in out) if out else []


# ── TypeScript: a small tokenizer, enough to find call arguments ────────────────


@dataclass
class Tok:
    kind: str  # str | tpl | id | punct | open | close | num
    text: str
    value: object = None  # str: decoded text; tpl: list of parts (str | ('expr', src))


@dataclass
class Group:
    open: str
    items: list = field(default_factory=list)  # Tok | Group


ESCAPES = {"n": "\n", "t": "\t", "r": "", "\\": "\\", "'": "'", '"': '"', "`": "`", "$": "$", "0": "\0"}
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^") | {"return", "typeof", "case", "in", "of", "=>", "delete", "void", "throw", "new", "else", "do"}


def _decode(raw: str) -> str:
    out = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            if nxt == "u" and i + 5 < len(raw) + 1 and re.match(r"[0-9a-fA-F]{4}", raw[i + 2:i + 6]):
                out.append(chr(int(raw[i + 2:i + 6], 16)))
                i += 6
                continue
            if nxt == "\n":
                i += 2
                continue
            out.append(ESCAPES.get(nxt, nxt))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def tokenize_ts(src: str) -> list[Tok]:
    toks: list[Tok] = []
    i, n = 0, len(src)

    def prev_sig() -> str | None:
        return toks[-1].text if toks else None

    def read_template(i: int) -> tuple[Tok, int]:
        """`i` is just after the opening backtick."""
        parts: list = []
        buf = []
        start = i - 1
        while i < n:
            c = src[i]
            if c == "\\":
                buf.append(src[i:i + 2])
                i += 2
                continue
            if c == "`":
                parts.append(_decode("".join(buf)))
                return Tok("tpl", src[start:i + 1], parts), i + 1
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                parts.append(_decode("".join(buf)))
                buf = []
                depth = 1
                j = i + 2
                # Skip the expression, honouring nested strings/templates/braces.
                while j < n and depth > 0:
                    d = src[j]
                    if d in "'\"":
                        j = skip_string(j)
                        continue
                    if d == "`":
                        _, j = read_template(j + 1)
                        continue
                    if d == "{":
                        depth += 1
                    elif d == "}":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                parts.append(("expr", src[i + 2:j]))
                i = j + 1
                continue
            buf.append(c)
            i += 1
        parts.append(_decode("".join(buf)))
        return Tok("tpl", src[start:], parts), n

    def skip_string(i: int) -> int:
        q = src[i]
        j = i + 1
        while j < n and src[j] != q:
            if src[j] == "\\":
                j += 1
            elif src[j] == "\n":
                break
            j += 1
        return j + 1

    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif c in "'\"":
            j = skip_string(i)
            raw = src[i + 1:j - 1]
            toks.append(Tok("str", src[i:j], _decode(raw)))
            i = j
        elif c == "`":
            tok, i = read_template(i + 1)
            toks.append(tok)
        elif c == "/" and (prev_sig() is None or prev_sig() in REGEX_PREV):
            j = i + 1
            in_class = False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            toks.append(Tok("regex", src[i:j]))
            i = j
        elif c in "([{":
            toks.append(Tok("open", c))
            i += 1
        elif c in ")]}":
            toks.append(Tok("close", c))
            i += 1
        elif c.isalpha() or c in "_$#":
            m = re.compile(r"[#A-Za-z_$][\w$]*").match(src, i)
            toks.append(Tok("id", m[0]))
            i = m.end()
        elif c.isdigit():
            m = re.compile(r"\d[\w.]*").match(src, i)
            toks.append(Tok("num", m[0]))
            i = m.end()
        else:
            m = re.compile(r"=>|\?\.|\?\?=?|\.\.\.|[=!]==?|[<>]=?|&&|\|\||[-+*/%&|^]=?|.").match(src, i)
            toks.append(Tok("punct", m[0]))
            i = m.end()
    return toks


def build_tree(toks: list[Tok]) -> Group:
    root = Group("")
    stack = [root]
    for t in toks:
        if t.kind == "open":
            g = Group(t.text)
            stack[-1].items.append(g)
            stack.append(g)
        elif t.kind == "close":
            if len(stack) > 1:
                stack.pop()
        else:
            stack[-1].items.append(t)
    return root


def split_args(g: Group) -> list[list]:
    args: list[list] = [[]]
    for it in g.items:
        if isinstance(it, Tok) and it.kind == "punct" and it.text == ",":
            args.append([])
        else:
            args[-1].append(it)
    return [a for a in args if a] if any(args) else []


SIMPLE_EXPR = re.compile(r"^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|!|\[\d+\])*$")


def placeholder(expr: str) -> str:
    e = expr.strip().replace("!", "")
    if SIMPLE_EXPR.match(e) and len(e) <= 40:
        return "{" + e.replace("?.", ".") + "}"
    return "{…}"


def ts_text(arg: list) -> list[str]:
    """The message variants an argument spells out, or [] when it isn't text."""
    def one(t) -> str | None:
        if isinstance(t, Tok) and t.kind == "str":
            return t.value  # type: ignore[return-value]
        if isinstance(t, Tok) and t.kind == "tpl":
            return "".join(p if isinstance(p, str) else placeholder(p[1]) for p in t.value)  # type: ignore[union-attr]
        return None

    if len(arg) == 1:
        s = one(arg[0])
        return [s] if s is not None else []
    # 'a' + b + `c` → "a{b}c"
    pieces = []
    plus = [i for i, t in enumerate(arg) if isinstance(t, Tok) and t.kind == "punct" and t.text == "+"]
    if plus and not any(isinstance(t, Tok) and t.text in ("?", ":", "??", "||", "&&") for t in arg):
        bounds = [-1, *plus, len(arg)]
        any_text = False
        for a, b in zip(bounds, bounds[1:]):
            part = arg[a + 1:b]
            s = one(part[0]) if len(part) == 1 else None
            if s is not None:
                any_text = True
                pieces.append(s)
            else:
                pieces.append("{…}")
        return ["".join(pieces)] if any_text else []
    # cond ? 'a' : 'b' (or a ?? 'b') → each literal is a variant
    out = [s for s in (one(t) for t in arg) if s is not None]
    return out


def object_prop(g: Group, key: str) -> list | None:
    if g.open != "{":
        return None
    for arg in split_args(g):
        if len(arg) >= 3 and isinstance(arg[0], Tok) and arg[0].text == key and isinstance(arg[1], Tok) and arg[1].text == ":":
            return arg[2:]
    return None


def severity_in(args: list[list]) -> str | None:
    for arg in args:
        for it in arg:
            if isinstance(it, Group):
                v = object_prop(it, "severity")
                if v and isinstance(v[0], Tok) and v[0].kind == "str":
                    return str(v[0].value)
            if isinstance(it, Tok) and it.kind == "str" and it.value == "warning":
                return "warning"
    return None


@dataclass
class Site:
    path: str
    messages: list[str] = field(default_factory=list)
    fixes: list[str] = field(default_factory=list)
    severity: str | None = None


def is_code_tok(t) -> bool:
    if not isinstance(t, Tok):
        return False
    if t.kind == "str":
        return bool(CODE_RE.match(str(t.value)))
    if t.kind == "tpl":
        parts = t.value
        return len(parts) == 1 and isinstance(parts[0], str) and bool(CODE_RE.match(parts[0]))  # type: ignore[arg-type]
    return False


def code_of(t: Tok) -> str:
    return str(t.value) if t.kind == "str" else t.value[0]  # type: ignore[index]


def positional_site(rel: str, args: list[list], k: int, is_call: bool) -> Site:
    """A raise site whose code is the k-th argument: fail('PP2041', `message`, { fix })."""
    site = Site(rel)
    last = k == len(args) - 1 and k > 0
    helper = not last and any(ts_text(a) for a in args[:k])  # known('prefab', 'PP2041', ...)
    if not is_call or helper:
        return site
    # The message is the first sentence-like text argument after the code
    # (`report(code, pointer, message, fix?)` puts a pointer in between); a
    # helper that takes the code last has its texts before it.
    texts = [ts_text(a) for a in (args[:k] if last else args[k + 1:k + 4])]
    picked = [t for t in texts if t]
    # Behind a code that isn't the first argument, a short lowercase text is the
    # helper's noun ("world layer"), not a message.
    words = 3 if k > 0 else 2
    first = next((i for i, t in enumerate(picked) if any(
        len(v.split()) >= words or (len(v.split()) >= 2 and not re.fullmatch(r"[a-z ]+", v)) for v in t)), None)
    if first is not None:
        site.messages = picked[first]
        if first + 1 < len(picked):
            site.fixes = picked[first + 1]
    for rest in args[k + 2:]:
        for x in rest:
            if isinstance(x, Group):
                v = object_prop(x, "fix")
                if v:
                    site.fixes += ts_text(v)
    site.severity = severity_in(args[k + 2:])
    return site


def code_param(arg: list) -> tuple[str, list[str]] | None:
    """`code: 'PP2041' | 'PP2042'` (optionally `= 'PP2041'`) in a parameter list."""
    if len(arg) < 3 or not (isinstance(arg[0], Tok) and arg[0].kind == "id" and isinstance(arg[1], Tok) and arg[1].text == ":"):
        return None
    codes, rest = [], arg[2:]
    for i, t in enumerate(rest):
        if i % 2 == 0:
            if not is_code_tok(t):
                return None
            codes.append(code_of(t))
        elif not (isinstance(t, Tok) and t.text in ("|", "=")):
            return None
    return (str(arg[0].text), codes) if codes else None


def scan_ts(rel: str, src: str) -> list[tuple[str, Site]]:
    found: list[tuple[str, Site]] = []

    def visit(g: Group) -> None:
        items = g.items
        for idx, it in enumerate(items):
            if isinstance(it, Group):
                handle_group(it, items[idx - 1] if idx > 0 else None)
                if it.open == "(":
                    params = [cp for a in split_args(it) if (cp := code_param(a))]
                    body = next((x for x in items[idx + 1:idx + 8] if isinstance(x, Group) and x.open == "{"), None)
                    if params and body is not None:
                        for name, codes in params:
                            for site in calls_with(body, name):
                                found.extend((c, site) for c in codes)
                visit(it)

    def calls_with(g: Group, name: str) -> list[Site]:
        """Raise sites inside a function body that pass its code parameter on."""
        out: list[Site] = []
        items = g.items
        for idx, it in enumerate(items):
            if not isinstance(it, Group):
                continue
            before = items[idx - 1] if idx > 0 else None
            if it.open == "(" and isinstance(before, Tok) and before.kind == "id":
                args = split_args(it)
                for k, arg in enumerate(args):
                    if len(arg) == 1 and isinstance(arg[0], Tok) and arg[0].text == name:
                        site = positional_site(rel, args, k, True)
                        if site.messages or site.fixes:
                            out.append(site)
            out += calls_with(it, name)
        return out

    def handle_group(g: Group, before) -> None:
        args = split_args(g)
        is_call = g.open == "(" and isinstance(before, Tok) and before.kind == "id"
        for k, arg in enumerate(args):
            if len(arg) == 1 and is_code_tok(arg[0]):
                found.append((code_of(arg[0]), positional_site(rel, args, k, is_call)))
            # Object property: { code: 'PP2063', message: ..., fix: ... }
            elif g.open == "{" and len(arg) == 3 and isinstance(arg[0], Tok) and arg[0].text == "code" \
                    and isinstance(arg[1], Tok) and arg[1].text == ":" and is_code_tok(arg[2]):
                site = Site(rel)
                msg = object_prop(g, "message")
                fix = object_prop(g, "fix")
                site.messages = ts_text(msg) if msg else []
                site.fixes = ts_text(fix) if fix else []
                sev = object_prop(g, "severity")
                if sev and isinstance(sev[0], Tok) and sev[0].kind == "str":
                    site.severity = str(sev[0].value)
                found.append((code_of(arg[2]), site))
            else:
                for t in arg:
                    if is_code_tok(t):
                        found.append((code_of(t), Site(rel)))

    root = build_tree(tokenize_ts(src))
    # Codes at the top level (outside any bracket) still count as raise sites.
    for t in root.items:
        if is_code_tok(t):
            found.append((code_of(t), Site(rel)))
    visit(root)
    return found


# ── Python: the stdlib ast ──────────────────────────────────────────────────────


def py_text(node: ast.AST | None) -> list[str]:
    if node is None:
        return []
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.JoinedStr):
        out = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                out.append(str(v.value))
            elif isinstance(v, ast.FormattedValue):
                out.append(placeholder(ast.unparse(v.value)))
        return ["".join(out)]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = py_text(node.left), py_text(node.right)
        if left or right:
            return [(left[0] if left else "{…}") + (right[0] if right else "{…}")]
    if isinstance(node, ast.IfExp):
        return py_text(node.body) + py_text(node.orelse)
    return []


def is_code_node(n: ast.AST) -> bool:
    return isinstance(n, ast.Constant) and isinstance(n.value, str) and bool(CODE_RE.match(n.value))


def callee_name(call: ast.Call) -> str:
    f = call.func
    return f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""


def scan_py(rel: str, src: str) -> list[tuple[str, Site]]:
    found: list[tuple[str, Site]] = []
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return found
    handled: set[int] = set()
    # `def unsupported(self, node, what, fix, code="PP6020")`: calls without code= raise the default.
    defaults: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            for a, d in zip(node.args.args[len(node.args.args) - len(node.args.defaults):], node.args.defaults):
                if a.arg == "code" and is_code_node(d):
                    defaults[node.name] = d.value  # type: ignore[attr-defined]
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            kw = {k.arg: k.value for k in node.keywords if k.arg}
            name = callee_name(node)
            if name in defaults and "code" not in kw and not any(is_code_node(a) for a in node.args):
                kw["code"] = ast.Constant(defaults[name])
            for k, a in enumerate(node.args):
                if is_code_node(a):
                    handled.add(id(a))
                    site = Site(rel)
                    if k + 1 < len(node.args):
                        site.messages = py_text(node.args[k + 1])
                    if k + 2 < len(node.args):
                        site.fixes = py_text(node.args[k + 2])
                    site.fixes += py_text(kw.get("fix"))
                    site.severity = (py_text(kw.get("severity")) or [None])[0]
                    found.append((a.value, site))  # type: ignore[union-attr]
            code = kw.get("code")
            if code is not None and is_code_node(code):
                handled.add(id(code))
                site = Site(rel)
                if name == "unsupported" and len(node.args) >= 3:
                    site.messages = [f"{m} is not supported in Parallax Python" for m in py_text(node.args[1])]
                    site.fixes = py_text(node.args[2])
                else:
                    site.messages = py_text(kw.get("message"))
                    site.fixes = py_text(kw.get("fix"))
                site.severity = (py_text(kw.get("severity")) or [None])[0]
                found.append((code.value, site))  # type: ignore[union-attr]
        elif isinstance(node, ast.Tuple) and len(node.elts) == 2 and is_code_node(node.elts[0]):
            # names.py: {"format": ("PP6107", "use an f-string: ...")} — (code, fix)
            handled.add(id(node.elts[0]))
            found.append((node.elts[0].value, Site(rel, fixes=py_text(node.elts[1]))))  # type: ignore[attr-defined]
        elif isinstance(node, ast.FunctionDef) and node.name == "unsupported":
            for d in node.args.defaults:
                if is_code_node(d):
                    handled.add(id(d))
                    found.append((d.value, Site(rel)))  # type: ignore[attr-defined]
    for node in ast.walk(tree):
        if is_code_node(node) and id(node) not in handled:
            found.append((node.value, Site(rel)))  # type: ignore[attr-defined]
    return found


# ── DIAGNOSTICS.md and README tables ────────────────────────────────────────────


def table_rows(text: str, heading: str) -> list[list[str]]:
    """Rows of the first table after `## heading`."""
    m = re.search(rf"^## {re.escape(heading)}\s*$", text, re.M)
    if not m:
        return []
    rows = []
    started = False
    for line in text[m.end():].splitlines():
        if line.startswith("|"):
            started = True
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if all(re.fullmatch(r"-+", c) for c in cells):
                continue
            rows.append(cells)
        elif started:
            break
    return rows[1:]  # drop the header


def parse_ranges(text: str) -> dict[str, str]:
    out = {r[0]: r[1] for r in table_rows(text, "The thousands") if len(r) >= 2}
    for k, v in EXTRA_RANGES.items():
        out.setdefault(k, v)
    return out


def parse_blocks(text: str) -> list[tuple[str, int, int]]:
    """(area, lo, hi) for every block in the 'Ranges per area' table."""
    blocks = []
    for row in table_rows(text, "Ranges per area"):
        if len(row) < 2:
            continue
        area, spec = row[0], re.sub(r"\([^)]*\)", "", row[1])
        for part in re.split(r",|/", spec):
            part = part.strip()
            m = re.match(r"PP(\d{4})\s*[–-]\s*(?:PP)?(\d{4})", part)
            if m:
                blocks.append((area, int(m[1]), int(m[2])))
                continue
            m = re.match(r"PP(\d{2})00s", part)
            if m:
                blocks.append((area, int(m[1]) * 100, int(m[1]) * 100 + 99))
                continue
            m = re.match(r"PP(\d{4})", part)
            if m:
                blocks.append((area, int(m[1]), int(m[1])))
    return blocks


def parse_shared(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for row in table_rows(text, "Shared codes"):
        if len(row) >= 2:
            for code in re.findall(r"PP\d{4}", row[0]):
                out[code] = strip_md(row[1])
    return out


def strip_md(s: str) -> str:
    return s.replace("`", "").strip()


def table_notes() -> dict[str, list[tuple[str, str]]]:
    """`| PPxxxx | meaning |` rows in package READMEs and DIAGNOSTICS.md (not the shared table)."""
    out: dict[str, list[tuple[str, str]]] = {}
    files = sorted(PACKAGES.glob("*/README.md")) + sorted(PACKAGES.glob("*/*.md"))
    seen: set[Path] = set()
    for f in files:
        if f in seen or f == DIAGNOSTICS_MD or f.parent.name in EXCLUDED_PACKAGES:
            continue
        seen.add(f)
        for line in f.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\|\s*`?(PP\d{4})`?\s*\|\s*(.+?)\s*\|\s*$", line)
            if m:
                rel = f.relative_to(ROOT).as_posix()
                out.setdefault(m[1], []).append((strip_md(m[2]), rel))
    return out


COMMENT_NOTE = re.compile(r"^\s*(?:\*|//|#)\s*(?:-\s*)?(PP\d{4})\s{2,}(\S.*?)\s*$")


def comment_notes(rel: str, src: str) -> list[tuple[str, str]]:
    return [(m[1], m[2]) for line in src.splitlines() if (m := COMMENT_NOTE.match(line))]


# ── Assemble ────────────────────────────────────────────────────────────────────


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def build_catalog() -> dict:
    diag_text = DIAGNOSTICS_MD.read_text(encoding="utf-8") if DIAGNOSTICS_MD.exists() else ""
    ranges = parse_ranges(diag_text)
    blocks = parse_blocks(diag_text)
    shared = parse_shared(diag_text)
    plugins = plugin_dirs()

    sites: dict[str, list[Site]] = {}
    notes: dict[str, list[tuple[str, str]]] = {}
    for rel in source_files():
        src = (PACKAGES / rel).read_text(encoding="utf-8")
        if "PP" not in src:
            continue
        found = scan_py(rel, src) if rel.endswith(".py") else scan_ts(rel, src)
        for code, site in found:
            sites.setdefault(code, []).append(site)
        for code, text in comment_notes(rel, src):
            notes.setdefault(code, []).append((clean(text), f"packages/{rel}"))
    for code, rows in table_notes().items():
        notes.setdefault(code, []).extend(rows)

    entries = []
    for code in sorted(sites):
        n = int(code[2:])
        range_key = f"PP{code[2]}xxx"
        areas = merge_spans({area_of(s.path, plugins) for s in sites[code]})
        messages: list[str] = []
        fixes: list[str] = []
        severities: set[str] = set()
        for s in sites[code]:
            for m in s.messages:
                m = clean(m)
                if m and " " in m and m not in messages:
                    messages.append(m)
            for f in s.fixes:
                f = clean(f)
                if f and f not in fixes:
                    fixes.append(f)
            if s.severity:
                severities.add(s.severity)
        code_notes = []
        for text, where in notes.get(code, []):
            if text and {"text": text, "source": where} not in code_notes:
                code_notes.append({"text": text, "source": where})
        entry = {
            "code": code,
            "range": range_key,
            "areas": areas,
            "listed_in": sorted({a for a, lo, hi in blocks if lo <= n <= hi}),
            "shared": shared.get(code),
            "severity": sorted(severities) if severities else ["error"],
            "messages": sorted(messages),
            "fixes": sorted(fixes),
            "notes": code_notes,
            "sources": sorted({f"packages/{s.path}" for s in sites[code]}),
            "docs": f"{DOCS_BASE}{code}",
        }
        if entry["shared"] is None:
            del entry["shared"]
        entries.append(entry)
    return {
        "generated_by": "tools/gen_error_catalog.py",
        "docs_base": DOCS_BASE,
        "ranges": [{"range": k, "meaning": v} for k, v in sorted(ranges.items())],
        "count": len(entries),
        "codes": entries,
    }


def md_cell(s: str) -> str:
    s = s.replace("\\", "\\\\").replace("|", "\\|").replace("<", "&lt;").replace(">", "&gt;")
    s = s.replace("*", "\\*").replace("_", "\\_").replace("[", "\\[").replace("]", "\\]").replace("`", "\\`")
    return s


def summary(e: dict) -> str:
    if e.get("shared"):
        return e["shared"]
    if e["messages"]:
        return e["messages"][0]
    if e["notes"]:
        return e["notes"][0]["text"]
    return ""


def render_readme(cat: dict) -> str:
    lines = [
        "<!-- Generated by tools/gen_error_catalog.py from the engine's sources. Do not edit. -->",
        "",
        "# Error catalog",
        "",
        "Every error and warning Parallax raises carries a stable code and prints a link to its page:",
        "",
        "```",
        "PP2041  Unknown prefab \"brik\"",
        "  at scenes/level_1/scene.json  (/entities/3/prefab)",
        "  Fix: Change \"brik\" to \"brick\".",
        f"  Docs: {DOCS_BASE}PP2041",
        "```",
        "",
        f"This index lists all {cat['count']} codes the engine's sources raise, grouped by range. The",
        "machine-readable form is [`catalog.json`](catalog.json): for each code, its range, the area that",
        "raises it, the message and fix texts found at its raise sites (interpolated values are written",
        "`{name}`), notes, and the source files. Search the sources for a code to find every place that",
        "raises it; each code means one thing. See [Diagnostics](../concepts/diagnostics.md) for how to read",
        "and act on them.",
        "",
        "Regenerate after adding or changing a code: `python3 tools/gen_error_catalog.py`.",
        "",
    ]
    by_range: dict[str, list[dict]] = {}
    for e in cat["codes"]:
        by_range.setdefault(e["range"], []).append(e)
    meanings = {r["range"]: r["meaning"] for r in cat["ranges"]}
    lines.append("| Range | Meaning | Codes |")
    lines.append("|---|---|---|")
    for r in sorted(by_range):
        lines.append(f"| [{r}](#{r.lower()}) | {meanings.get(r, '').replace('|', '&#124;')} | {len(by_range[r])} |")
    lines.append("")
    for r in sorted(by_range):
        lines.append(f"## {r}")
        lines.append("")
        if meanings.get(r):
            lines.append(meanings[r][0].upper() + meanings[r][1:] + ".")
            lines.append("")
        lines.append("| Code | Area | Message |")
        lines.append("|---|---|---|")
        for e in by_range[r]:
            lines.append(f"| {e['code']} | {md_cell(', '.join(e['areas']))} | {md_cell(summary(e))} |")
        lines.append("")
    return "\n".join(lines)


def outputs() -> dict[Path, str]:
    cat = build_catalog()
    return {
        OUT_DIR / "catalog.json": json.dumps(cat, indent=2, ensure_ascii=False) + "\n",
        OUT_DIR / "README.md": render_readme(cat),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="exit 1 if the committed output is stale")
    args = ap.parse_args(argv)
    files = outputs()
    if args.check:
        stale = [p for p, text in files.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
        for p in stale:
            print(f"stale: {p.relative_to(ROOT).as_posix()} (run python3 tools/gen_error_catalog.py)", file=sys.stderr)
        return 1 if stale else 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for p, text in files.items():
        p.write_text(text, encoding="utf-8")
    count = json.loads(files[OUT_DIR / "catalog.json"])["count"]
    print(f"wrote {count} codes to {(OUT_DIR / 'catalog.json').relative_to(ROOT).as_posix()} and README.md")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
