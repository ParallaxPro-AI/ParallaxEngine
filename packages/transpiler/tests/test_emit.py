"""The emitted module shape (contract C1) and the transpiler's rejections."""

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from parallax_transpiler.compile import compile_module
from parallax_transpiler.project import ProjectIndex

INDEX = ProjectIndex.from_paths([
    "game/main.py", "game/components.py", "game/systems/stages.py", "game/chess/__init__.py",
    "game/chess/moves.py", "game/logic.py",
])


def js(source: str, path: str = "game/logic.py") -> str:
    result = compile_module(textwrap.dedent(source), path, INDEX)
    assert result.js is not None, "\n".join(d.format() for d in result.diagnostics)
    return result.js


def codes(source: str, path: str = "game/logic.py") -> list[str]:
    result = compile_module(textwrap.dedent(source), path, INDEX)
    if result.diagnostics:
        assert result.js is None, "a file with diagnostics must not produce a module"
    return [d.code for d in result.diagnostics]


class Imports(unittest.TestCase):
    def test_sdk_project_and_relative_imports(self) -> None:
        out = js("""
            from parallax import Behavior, behavior
            from parallax.physics import Rigidbody
            from project import Prefabs
            from game.components import Brick
            from game.chess import moves
            from ..components import Paddle
            import math
        """, "game/systems/stages.py")
        self.assertIn("import * as $rt from 'parallax/__rt__';", out)
        self.assertIn("import { Behavior, behavior } from 'parallax';", out)
        self.assertIn("import { Rigidbody } from 'parallax/physics';", out)
        self.assertIn("import { Prefabs } from 'project';", out)
        self.assertIn("import { Brick, Paddle } from '../components.js';", out)
        self.assertIn("import * as moves from '../chess/moves.js';", out)
        self.assertIn("math = $rt.math;", out)
        self.assertRegex(out, r"export \{ .*Behavior.*math.* \};")

    def test_sdk_submodule_imported_from_parallax_is_a_namespace(self) -> None:
        out = js("""
            from parallax import Game, physics
            from parallax import combat as fight
        """, "game/main.py")
        self.assertIn("import { Game } from 'parallax';", out)
        self.assertIn("import * as physics from 'parallax/physics';", out)
        self.assertIn("import * as fight from 'parallax/combat';", out)

    def test_renamed_sdk_names_are_pp6012_naming_the_new_one(self) -> None:
        self.assertEqual(codes("from parallax.combat import Hit"), ["PP6012"])
        self.assertEqual(codes("from parallax.combat import Effects"), ["PP6012"])
        self.assertEqual(codes("from parallax.physics import Hit"), ["PP6012"])
        self.assertEqual(codes("from parallax import DialoguePanel"), ["PP6012"])
        self.assertEqual(codes("from parallax import plugins\np = plugins.narrative()"), ["PP6012"])
        self.assertEqual(codes("from parallax import combat as fight\nh = fight.Hit"), ["PP6012"])
        self.assertEqual(codes("from parallax import plugins\np = plugins.story()"), [])
        self.assertEqual(codes("from parallax.combat import DamageHit, StatusEffects"), [])

    def test_function_level_imports_bind_locally(self) -> None:
        out = js("""
            def f():
                from game.components import Brick
                return Brick
        """)
        self.assertIn("import * as $m", out)
        self.assertIn('Brick = $m', out)


class Classes(unittest.TestCase):
    def test_annotations_statics_and_decorators(self) -> None:
        out = js("""
            from parallax import Behavior, ContentRef, behavior, param, state
            from typing import Literal
            from game.components import Item

            @behavior("paddle", requires=[Item])
            class Paddle(Behavior):
                speed: float = param(14, unit="m/s")
                lives: int = state(3)
                names: list[str]
                table: dict[str, int]
                target: Item | None
                pair: tuple[int, float]
                mode: Literal["a", "b"]
                ref: ContentRef[Item]
                later: "Paddle"
        """)
        self.assertIn("Paddle = class extends Behavior {", out)
        for thunk in ['"speed": () => $rt.types.float', '"lives": () => $rt.types.int',
                      '"names": () => $rt.types.list($rt.types.str)',
                      '"table": () => $rt.types.dict($rt.types.str, $rt.types.int)',
                      '"target": () => $rt.types.optional(Item)',
                      '"pair": () => $rt.types.tuple($rt.types.int, $rt.types.float)',
                      '"mode": () => $rt.types.literal("a", "b")',
                      '"ref": () => $rt.types.generic(ContentRef, Item)', '"later": () => Paddle']:
            self.assertIn(thunk, out)
        self.assertIn('$rt.class_attr(Paddle, "speed", $rt.call(param, 14, $rt.kw({ "unit": "m/s" })));', out)
        self.assertIn("$rt.init_subclass(Paddle);", out)
        self.assertIn('Paddle = $rt.call(behavior, "paddle", $rt.kw({ "requires": [Item] }))(Paddle);', out)
        self.assertLess(out.index("$rt.init_subclass(Paddle)"), out.index("Paddle = $rt.call(behavior"))

    def test_enum_is_finished_before_decorators(self) -> None:
        out = js("""
            from enum import Enum
            class Phase(Enum):
                PLAYING = "playing"
                WON = "won"
        """)
        self.assertIn("Enum = $rt.enum.Enum;", out)
        self.assertIn("Phase = class extends Enum {", out)
        self.assertIn("Phase = $rt.enum_class(Phase);", out)

    def test_methods_bind_self_and_handlers_decorate_in_place(self) -> None:
        out = js("""
            from parallax import System, on, system
            from game.components import Hit

            class Rules(System):
                @on(Hit, where=lambda e: e.ok)
                def hit(self, ctx, event: Hit):
                    self.count += 1
        """)
        self.assertIn("hit(ctx, event) {", out)
        self.assertIn("const self = this;", out)
        self.assertIn('$rt.fn_annotations(Rules.prototype.hit, { "event": () => Hit });', out)
        self.assertIn('$rt.decorate_method(Rules, "hit", [$rt.call(on, Hit, $rt.kw({ "where":', out)

    def test_eq_without_hash_is_unhashable(self) -> None:
        out = js("""
            class V:
                def __eq__(self, other):
                    return True
        """)
        self.assertIn("$rt.no_hash(V);", out)


class Functions(unittest.TestCase):
    def test_tasks_are_generators(self) -> None:
        out = js("""
            async def intro(ctx, task):
                await task.seconds(1)
        """)
        self.assertIn("intro = $rt.pyfn($rt.async_fn(function* (ctx, task) {", out)
        self.assertIn("(yield* $rt.await_(task.seconds(1)));", out)

    def test_keyword_binding_and_function_annotations(self) -> None:
        out = js("""
            def spawn(ctx, kind: int, *, drop: int = 0):
                return kind + drop
        """)
        self.assertIn('$rt.sig("spawn", ["ctx", "kind"], 0, [], ["drop"], [0], null, null, false)', out)
        self.assertIn("let [ctx, kind, drop] = $rt.bind(", out)
        self.assertIn('$rt.fn_annotations(', out)
        self.assertIn('{ "kind": () => $rt.types.int, "drop": () => $rt.types.int }', out)

    def test_calls_route_by_what_is_known(self) -> None:
        out = js("""
            import random
            from parallax import vec2
            def helper(x):
                return x
            class Local:
                pass
            a = helper(1)
            b = vec2(1, 2)
            c = Local()
            d = len([1])
            e = random.choice([1])
            f = ValueError("x")
        """)
        self.assertIn("a = helper(1);", out)
        self.assertIn("b = $rt.call(vec2, 1, 2);", out)
        self.assertIn("c = new Local();", out)
        self.assertIn("d = $rt.len([1]);", out)
        self.assertIn("e = $rt.random.choice([1]);", out)
        self.assertIn('f = new $rt.ValueError("x");', out)


class Rejections(unittest.TestCase):
    def test_unsupported_constructs_have_codes(self) -> None:
        self.assertEqual(codes("x = undefined_name"), ["PP6010"])
        self.assertEqual(codes("x = document"), ["PP6010"])
        self.assertEqual(codes("x = id(3)"), ["PP6011"])
        self.assertEqual(codes("from math import fsum"), ["PP6012"])
        self.assertEqual(codes("import math\nx = math.fsum([1])"), ["PP6012"])
        self.assertIn("PP6001", codes("from itertools import chain"))
        self.assertEqual(codes("from game.nothing import x"), ["PP6013"])
        self.assertEqual(codes("from parallax import *"), ["PP6013"])
        self.assertEqual(codes("with open_it() as f:\n    pass"), ["PP6020"])
        self.assertEqual(codes("def g():\n    yield 1"), ["PP6020"])
        self.assertEqual(codes("match 1:\n    case 1:\n        pass"), ["PP6020"])
        self.assertEqual(codes('s = "{}".format(1)'), ["PP6107"])
        self.assertEqual(codes('s = "%d" % 1'), ["PP6106"])
        self.assertEqual(codes("n = 2 ** 64 if False else 18446744073709551616"), ["PP6022"])
        self.assertEqual(codes("class A:\n    pass\nclass B:\n    pass\nclass C(A, B):\n    pass"), ["PP6030"])
        self.assertEqual(codes("from enum import Enum\nclass E(Enum):\n    A = (1, 2)"), ["PP6032"])
        self.assertEqual(codes("def f():\n    return super().x"), ["PP6030"])
        self.assertEqual(codes("x = b'raw'"), ["PP6021"])
        self.assertEqual(codes("async def g():\n    pass\ndef f():\n    await g()"), ["PP6021"])

    def test_js_internals_never_compile(self) -> None:
        self.assertEqual(codes('f = "".constructor'), ["PP6003"])
        self.assertEqual(codes("class A:\n    def constructor(self):\n        pass"), ["PP6003"])
        self.assertEqual(codes("def f(**k):\n    pass\nf(__proto__=1)"), ["PP6003"])

    def test_every_diagnostic_points_at_a_line_with_a_fix(self) -> None:
        result = compile_module("x = 1\ny = nope\n", "game/logic.py", INDEX)
        [d] = result.diagnostics
        self.assertEqual((d.code, d.line), ("PP6010", 2))
        self.assertTrue(d.fix)
        self.assertIsNone(result.js)


class Build(unittest.TestCase):
    def test_cli_writes_modules_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            (project / "game").mkdir(parents=True)
            (project / "game" / "__init__.py").write_text("")
            (project / "game" / "main.py").write_text("from game.rules import score\nTOTAL = score(2)\n")
            (project / "game" / "rules.py").write_text("def score(n):\n    return n * 10\n")
            (project / "game" / "broken.py").write_text("x = nope\n")
            out = Path(tmp) / "build"
            proc = subprocess.run([sys.executable, "-m", "parallax_transpiler", "build", str(project), str(out)],
                                  capture_output=True, text=True, cwd=Path(__file__).parent.parent, check=False)
            self.assertEqual(proc.returncode, 1, proc.stderr)
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual(manifest["entry"], "game/main.js")
            outputs = {m["source"]: m["output"] for m in manifest["modules"]}
            self.assertEqual(outputs["game/main.py"], "game/main.js")
            self.assertIsNone(outputs["game/broken.py"])
            self.assertEqual([d["code"] for d in manifest["diagnostics"]], ["PP6010"])
            self.assertTrue((out / "game" / "rules.js").exists())
            self.assertFalse((out / "game" / "broken.js").exists())
            self.assertIn("import { score } from './rules.js';", (out / "game" / "main.js").read_text())


if __name__ == "__main__":
    unittest.main()
