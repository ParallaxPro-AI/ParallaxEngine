"""Conformance: every snippet in conformance_cases.py runs under CPython and, compiled, under
Node against pyrt (runtime/src/api/pyrt, TypeScript run with Node's type stripping).
The outputs must be identical."""

import contextlib
import inspect
import io
import json
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

from parallax_transpiler.compile import compile_module
from parallax_transpiler.project import ProjectIndex
from tests.conformance_cases import CASES

NODE_DIR = Path(__file__).parent / "node"


def run_cpython(name: str, source: str) -> str:
    out = io.StringIO()
    helpers = types.ModuleType("helpers")
    exec(compile((NODE_DIR / "helpers.py").read_text(), "helpers.py", "exec"), helpers.__dict__)
    saved = sys.modules.get("helpers")
    sys.modules["helpers"] = helpers
    namespace: dict[str, object] = {"__name__": f"snippet_{name}"}
    try:
        with contextlib.redirect_stdout(out):
            try:
                exec(compile(source, f"{name}.py", "exec"), namespace)
                main = namespace.get("main")
                if inspect.iscoroutinefunction(main):
                    coro = main()  # type: ignore[operator]
                    value = coro.send(None)
                    while True:
                        print(f"yield {value!r}")
                        value = coro.send(f"sent:{value!r}")
            except StopIteration:
                pass
            except BaseException as e:  # noqa: BLE001 — reported like the JS side
                print(f"{type(e).__name__}: {e}")
    finally:
        if saved is None:
            sys.modules.pop("helpers", None)
        else:
            sys.modules["helpers"] = saved
    return out.getvalue()


def run_node(sources: dict[str, str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Compile every snippet, run the compiled modules in one Node process."""
    index = ProjectIndex.from_paths([f"{name}.py" for name in sources] + ["helpers.py"])
    diagnostics: dict[str, list[str]] = {}
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copy(NODE_DIR / "helpers.js", Path(tmp) / "helpers.js")
        modules = []
        for name, source in sources.items():
            result = compile_module(source, f"{name}.py", index)
            if result.js is None:
                diagnostics[name] = [d.format() for d in result.diagnostics]
                continue
            path = Path(tmp) / f"{name}.js"
            path.write_text(result.js)
            modules.append({"name": name, "path": str(path)})
        listing = Path(tmp) / "modules.json"
        listing.write_text(json.dumps(modules))
        proc = subprocess.run(
            ["node", "--no-warnings", "--import", str(NODE_DIR / "register.mjs"), str(NODE_DIR / "run_modules.mjs"),
             str(listing)],
            capture_output=True, text=True, timeout=120, check=False)
        if proc.returncode != 0:
            raise AssertionError(f"node failed:\n{proc.stderr}")
        return json.loads(proc.stdout), diagnostics


class Conformance(unittest.TestCase):
    node: dict[str, str]
    diagnostics: dict[str, list[str]]

    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("node") is None:
            raise unittest.SkipTest("node is not installed")
        cls.node, cls.diagnostics = run_node(CASES)

    def test_snippets_match_cpython(self) -> None:
        for name, source in CASES.items():
            with self.subTest(name):
                self.assertNotIn(name, self.diagnostics, "\n".join(self.diagnostics.get(name, [])))
                self.assertEqual(self.node[name], run_cpython(name, source))


if __name__ == "__main__":
    unittest.main()
