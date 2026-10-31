"""Built-in panels a game may subclass to restyle: `parallax check` reads their state keys
from the SDK docstring, which must open with the shape (`{shown, ...}`), or every binding in
the subclass's markup fails PP2070."""

import ast
import unittest
from pathlib import Path

from parallax_transpiler.extract.shapes import documented

SDK = Path(__file__).resolve().parents[3] / "sdk" / "parallax"


def panel_doc(module: str, name: str) -> str | None:
    tree = ast.parse((SDK / module).read_text())
    node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)
    return ast.get_docstring(node)


class RestylablePanelsDocumentTheirState(unittest.TestCase):
    def test_interact_prompt_keys_are_read(self) -> None:
        shape = documented(panel_doc("interaction.pyi", "InteractPromptPanel"))
        assert shape is not None
        self.assertEqual(list(shape["keys"]), ["shown", "text", "keys", "hold", "fill", "x", "y", "anchored", "a11y"])
        self.assertEqual(list(shape["keys"]["keys"]["item"]["keys"]), ["text", "code", "device", "pad", "touch"])

    def test_hud_kit_panels_are_read(self) -> None:
        for name in ("MinimapPanel", "CompassPanel", "NameplatesPanel", "MarkersPanel"):
            self.assertIsNotNone(documented(panel_doc("hud.pyi", name)), name)


if __name__ == "__main__":
    unittest.main()
