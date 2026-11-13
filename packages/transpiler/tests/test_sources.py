import tempfile
import unittest
from pathlib import Path

from parallax_transpiler.extract.sources import load_project_modules
from parallax_transpiler.project import ProjectIndex


def project(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp())
    for path, text in files.items():
        file = root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
    return root


class ProjectModules(unittest.TestCase):
    def test_top_level_tools_are_authoring_scripts_not_game_code(self) -> None:
        root = project({
            "game/main.py": "x = 1\n",
            "game/tools/helpers.py": "y = 2\n",
            "tools/gen_content.py": "import json\nimport pathlib\nprint(__file__)\n",
            "tools/nested/more.py": "import os\n",
        })
        names = set(load_project_modules(root, []))
        self.assertIn("game.main", names)
        self.assertIn("game.tools.helpers", names)
        self.assertNotIn("tools.gen_content", names)
        self.assertNotIn("tools.nested.more", names)

    def test_a_top_level_tools_module_file_is_still_game_code(self) -> None:
        names = set(load_project_modules(project({"tools.py": "z = 3\n"}), []))
        self.assertIn("tools", names)

    def test_the_build_does_not_compile_authoring_tools(self) -> None:
        root = project({
            "game/main.py": "x = 1\n",
            "tests/test_a.py": "a = 1\n",
            "tools/gen_scenes.py": "import json\n",
        })
        modules = set(ProjectIndex.scan(root).modules)
        self.assertEqual(modules, {"game.main", "tests.test_a"})

    def test_playtests_and_output_are_skipped(self) -> None:
        root = project({"tests/test_a.py": "a = 1\n", "build/out.py": "b = 1\n", "game/main.py": "c = 1\n"})
        self.assertEqual(set(load_project_modules(root, [])), {"game.main"})


if __name__ == "__main__":
    unittest.main()
