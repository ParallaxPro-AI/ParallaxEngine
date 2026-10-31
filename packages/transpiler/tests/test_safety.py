import unittest

from parallax_transpiler import check_safety


def codes(source: str, local: frozenset[str] = frozenset({"game"})) -> list[str]:
    return [d.code for d in check_safety(source, "game/logic.py", local)]


class EscapesAreRejected(unittest.TestCase):
    def test_constructor_chain_is_rejected(self) -> None:
        # Compiles verbatim to Function("…") in JS — the escape found in the old transpiler.
        self.assertIn("PP6003", codes('f = "".constructor.constructor("return document.cookie")'))

    def test_js_internals_via_subscript_are_rejected(self) -> None:
        self.assertEqual(codes('f = x["constructor"]'), ["PP6003"])
        self.assertEqual(codes("p = obj.__proto__"), ["PP6003"])

    def test_dunder_reads_are_rejected(self) -> None:
        self.assertEqual(codes("k = self.__class__"), ["PP6003"])
        self.assertEqual(codes('k = getattr(self, "__dict__")'), ["PP6003"])

    def test_dynamic_attribute_names_are_rejected(self) -> None:
        self.assertEqual(codes("v = getattr(obj, name)"), ["PP6004"])

    def test_host_builtins_are_rejected(self) -> None:
        self.assertEqual(codes('eval("1 + 1")'), ["PP6002"])
        self.assertEqual(codes('f = open("x")'), ["PP6002"])
        self.assertEqual(codes('m = __import__("os")'), ["PP6002"])

    def test_imports_outside_the_allowlist_are_rejected(self) -> None:
        self.assertEqual(codes("import os"), ["PP6001"])
        self.assertEqual(codes("from subprocess import run"), ["PP6001"])

    def test_unprovided_stdlib_modules_are_rejected_with_a_hint(self) -> None:
        for module in ("itertools", "functools", "json"):
            [d] = check_safety(f"import {module}", "game/logic.py")
            self.assertEqual(d.code, "PP6001")
            self.assertIn(f"{module} is not available", d.fix or "")


class OrdinaryGameCodeIsAccepted(unittest.TestCase):
    def test_sdk_stdlib_and_local_imports(self) -> None:
        source = "\n".join([
            "import math",
            "import random",
            "from enum import Enum",
            "from parallax import Behavior, behavior, param",
            "from parallax.combat import Health",
            "from project import Prefabs",
            "from game.rules import current_stage",
            "from .events import RoundWon",
        ])
        self.assertEqual(codes(source), [])

    def test_dunder_definitions_super_init_and_literal_getattr(self) -> None:
        source = "\n".join([
            "class Money:",
            "    def __init__(self, amount):",
            "        super().__init__()",
            "        self.amount = amount",
            "    def __add__(self, other):",
            "        return Money(self.amount + other.amount)",
            'speed = getattr(config, "speed")',
        ])
        self.assertEqual(codes(source), [])

    def test_diagnostics_point_at_the_line_and_carry_a_fix(self) -> None:
        [d] = check_safety("x = 1\nimport os\n", "game/logic.py")
        self.assertEqual((d.code, d.line, d.column), ("PP6001", 2, 1))
        self.assertIn("Fix:", d.format())
        self.assertEqual(d.docs, "https://parallaxpro.ai/docs/engine/errors/PP6001")


if __name__ == "__main__":
    unittest.main()
