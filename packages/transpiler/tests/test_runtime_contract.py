"""The transpiler and pyrt agree: every `$rt.<name>` the emitter can produce exists in pyrt,
every builtin/stdlib/method table entry is implemented, and `random` draws from the
game's seeded source deterministically."""

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from parallax_transpiler import names as N
from tests.test_conformance import run_node

NODE_DIR = Path(__file__).parent / "node"
EMIT = Path(__file__).parent.parent / "parallax_transpiler" / "emit.py"


def surface() -> dict:
    proc = subprocess.run(["node", "--no-warnings", "--import", str(NODE_DIR / "register.mjs"),
                           str(NODE_DIR / "runtime_surface.mjs")], capture_output=True, text=True, timeout=60, check=True)
    return json.loads(proc.stdout)


@unittest.skipIf(shutil.which("node") is None, "node is not installed")
class RuntimeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rt = surface()

    def test_emitted_helpers_exist(self) -> None:
        emitted = set(re.findall(r"\{RT\}\.([A-Za-z_]+)", EMIT.read_text())) - {"i"}  # f"{RT}.i{op}" below
        emitted |= {f"i{op.rstrip('_')}" for op in ("add", "sub", "mul", "truediv", "floordiv", "mod", "pow",
                                                     "lshift", "rshift", "and_", "or_", "xor", "matmul")}
        emitted |= {"add", "sub", "mul", "truediv", "floordiv", "mod", "pow", "lshift", "rshift", "and_", "or_", "xor",
                    "matmul", "eq", "ne", "lt", "le", "gt", "ge", "neg", "pos", "invert", "str_float", "repr_float"}
        self.assertEqual(sorted(emitted - set(self.rt["exports"])), [])

    def test_builtins_stdlib_and_methods_exist(self) -> None:
        self.assertEqual(sorted(set(N.BUILTINS.values()) - set(self.rt["exports"])), [])
        self.assertEqual(sorted(N.DISPATCHED_METHODS - set(self.rt["methods"])), [])
        for module, members in N.STDLIB.items():
            for target in members.values():
                shim, member = target.split(".", 1)
                self.assertIn(member, self.rt["shims"][shim], f"{module}: {target}")

    def test_type_markers_cover_annotations(self) -> None:
        # Markers C1 names (api types.ts `rt`); the others the emitter can produce are
        # reported to api core when missing.
        self.assertTrue({"float", "int", "str", "bool", "list", "dict", "optional", "tuple", "literal", "generic"}
                        <= set(self.rt["types"]))

    def test_random_is_seeded_and_in_range(self) -> None:
        source = "\n".join([
            "import random",
            "xs = [random.random() for _ in range(200)]",
            "print(all(0 <= x < 1 for x in xs), len(set(xs)) > 190)",
            "print(all(1 <= random.randint(1, 6) <= 6 for _ in range(200)))",
            "print(all(2 <= random.uniform(2, 3) <= 3 for _ in range(50)))",
            "print(sorted(random.sample(range(10), 10)) == list(range(10)), len(random.sample('abcdef', 3)))",
            "deck = list(range(20))",
            "random.shuffle(deck)",
            "print(sorted(deck) == list(range(20)), random.choice([7]), random.choices(['a', 'b'], weights=[0, 1], k=3))",
            "print(random.randrange(5, 6), random.gauss(0, 0) == 0.0)",
            "first = [random.random() for _ in range(3)]",
            "print(first)",
        ])
        out, diagnostics = run_node({"rand_a": source, "rand_b": source})
        self.assertEqual(diagnostics, {})
        lines = out["rand_a"].splitlines()
        self.assertEqual(lines[:6], ["True True", "True", "True", "True 3", "True 7 ['b', 'b', 'b']", "5 True"])
        self.assertEqual(out["rand_a"], out["rand_b"], "same seed, same draws")


if __name__ == "__main__":
    unittest.main()
