"""Source maps: each compiled module's JS lines map back to its .py lines (standard v3)."""

import json
import tempfile
import textwrap
import unittest
from pathlib import Path

from parallax_transpiler.build import build
from parallax_transpiler.compile import compile_module
from parallax_transpiler.project import ProjectIndex
from parallax_transpiler.source_map import mappings, strip_marks, vlq

B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def decode(mapped: str) -> list[int]:
    """The 1-based source line of each generated line (0 = unmapped), per the v3 spec."""
    out: list[int] = []
    line = 0
    for group in mapped.split(";"):
        if not group:
            out.append(0)
            continue
        values: list[int] = []
        shift = n = 0
        for ch in group.split(",")[0]:
            digit = B64.index(ch)
            n |= (digit & 31) << shift
            shift += 5
            if not digit & 32:
                values.append(-(n >> 1) if n & 1 else n >> 1)
                shift = n = 0
        line += values[2]
        out.append(line + 1)
    return out


SOURCE = textwrap.dedent('''\
    import math


    class Paddle:
        speed = 3

        def move(self, dx):
            x = dx * self.speed
            if x > 10:
                raise ValueError("too fast")
            elif x < 0:
                return 0
            return x


    def boom():
        """doc"""
        return Paddle().move(99)
''')


class SourceMaps(unittest.TestCase):
    def test_vlq(self) -> None:
        self.assertEqual([vlq(v) for v in (0, 1, -1, 15, 16, -16, 123)], ["A", "C", "D", "e", "gB", "hB", "2H"])

    def test_mappings_round_trip(self) -> None:
        table = [0, 0, 3, 3, 7, 1, 0, 12]
        self.assertEqual(decode(mappings(table)), table)

    def test_strip_marks(self) -> None:
        js, lines = strip_marks("a;\n\x004\x00b {\n  c;\n}\n\x009\x00d;\n")
        self.assertEqual(js, "a;\nb {\n  c;\n}\nd;\n")
        self.assertEqual(lines, [0, 4, 4, 4, 9, 0])

    def test_statements_map_to_their_python_lines(self) -> None:
        result = compile_module(SOURCE, "game/logic.py", ProjectIndex.from_paths(["game/logic.py"]))
        assert result.js is not None
        self.assertNotIn("\x00", result.js)
        js_lines = result.js.split("\n")
        self.assertEqual(len(js_lines), len(result.lines))
        where = {code.strip(): line for code, line in zip(js_lines, result.lines)}
        self.assertEqual(where["math = $rt.math;"], 1)
        self.assertEqual(where["move(dx) {"], 7)
        self.assertEqual(where['throw $rt.raise_(new $rt.ValueError("too fast"));'], 10)
        self.assertEqual(where["} else if ($rt.lt(x, 0)) {"], 11)
        self.assertEqual(where["return 0;"], 12)
        self.assertEqual(where['$rt.class_info(Paddle, "Paddle");'], 4)
        self.assertEqual(where['$rt.class_attr(Paddle, "speed", 3);'], 5)
        self.assertEqual(where["return new Paddle().move(99);"], 18)
        self.assertEqual(result.lines[0], 0)  # the pyrt import is the transpiler's own

    def test_build_writes_maps_next_to_modules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            (project / "game").mkdir(parents=True)
            (project / "game" / "logic.py").write_text(SOURCE)
            (project / "game" / "main.py").write_text("from game.logic import boom\n")
            out = Path(tmp) / "build"
            build(project, out)
            js = (out / "game" / "logic.js").read_text()
            self.assertTrue(js.endswith("//# sourceMappingURL=logic.js.map\n"))
            source_map = json.loads((out / "game" / "logic.js.map").read_text())
            self.assertEqual(source_map["version"], 3)
            self.assertEqual(source_map["file"], "logic.js")
            self.assertEqual(source_map["sources"], ["../../proj/game/logic.py"])
            self.assertEqual(source_map["sourcesContent"], [SOURCE])
            lines = decode(source_map["mappings"])
            js_lines = js.split("\n")
            raise_at = next(i for i, code in enumerate(js_lines) if "too fast" in code)
            self.assertEqual(lines[raise_at], 10)
            self.assertLessEqual(len(lines), len(js_lines))


if __name__ == "__main__":
    unittest.main()
