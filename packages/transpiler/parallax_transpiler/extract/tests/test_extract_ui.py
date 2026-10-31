"""Panels, action sets, Game(...), features, project handles and spawn sites."""

import unittest
from pathlib import Path

from parallax_transpiler.extract import extract_project
from parallax_transpiler.extract.tests.helpers import codes, diagnostic, extract

EXAMPLES = Path(__file__).resolve().parents[5] / "examples"


class Panels(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = extract({"game/ui.py": '''
            from parallax import (ContentRef, Panel, SettingsPanel, action, close_panel, load_scene, open_panel,
                                  reload_scene, ui)
            from project import Scenes
            from game.actions import Controls
            from game.events import Picked

            to_title = load_scene(Scenes.title, new_run=True)

            @action(when=lambda ctx: True)
            def choose(ctx, slot: int, label: str = ""):
                pass

            def rows(ctx):
                out = []
                for i in range(3):
                    out.append({"slot": i, "label": "x"})
                return out

            @ui("hud", html="ui/hud.html")
            class Hud(Panel):
                actions = {"pause": open_panel(SettingsPanel), "title": to_title, "pick": Picked, "choose": choose}

                def state(self, ctx):
                    base = {"score": 1}
                    return {**base, "cards": [{"id": c, "name": "n"} for c in range(2)], "rows": rows(ctx),
                            "best": max(1, 2) if True else 0}

            @ui("pause", html="ui/pause.html", modal=True, layer="menu", scale="design", scenes=[Scenes.arena],
                toggle_with=Controls.pause)
            class Pause(Panel):
                actions = {"resume": close_panel(), "retry": reload_scene(new_run=True)}

            @ui("over", html="ui/over.html", modal=True, when=lambda ctx: True, toggle_with=Controls.pause, delay=0.5)
            class Over(Panel):
                actions = {"close": close_panel()}

                def state(self, ctx):
                    return self.compute(ctx)

            @ui("held", html="ui/held.html", while_held=Controls.move)
            class Held(Panel):
                pass
        ''', "game/actions.py": '''
            from parallax import Actions, axis2, button, button_group, gamepad, keys, touch

            class Controls(Actions):
                move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
                pause = button(keyboard=("KeyP", "Enter"), gamepad=gamepad.START)
                slots = button_group(keyboard=("Digit1", None), gamepad=(None, gamepad.NORTH))
                bad = button(keyboard="Spacebar", gamepad="South", touch=touch.SWIPE)

            class Player2(Controls):
                priority = 1
                move = axis2(keyboard=keys.composite(up="KeyI", left="KeyJ", down="KeyK", right="Keyl"))

                @staticmethod
                def active_when(ctx, owner):
                    return True
        ''', "game/events.py": '''
            from parallax import event

            @event("picked")
            class Picked:
                slot: int
        '''})

    def test_actions_and_state(self) -> None:
        hud = self.doc["panels"]["hud"]
        actions = hud["actions"]
        self.assertEqual((actions["pause"]["command"], actions["pause"]["builtin"]), ("open_panel", "SettingsPanel"))
        self.assertEqual((actions["title"]["command"], actions["title"]["scene"], actions["title"]["new_run"]), ("load_scene", "title", True))
        self.assertEqual(actions["pick"]["event"], "picked")
        self.assertEqual(actions["choose"]["kind"], "function")
        self.assertEqual((actions["choose"]["params"], actions["choose"]["required"]), (["slot", "label"], ["slot"]))
        self.assertTrue(actions["choose"]["when"])
        state = hud["state"]
        self.assertEqual(set(state["keys"]), {"score", "cards", "rows", "best"})
        self.assertFalse(state["open"])
        self.assertEqual(set(state["keys"]["cards"]["item"]["keys"]), {"id", "name"})
        self.assertEqual(set(state["keys"]["rows"]["item"]["keys"]), {"slot", "label"})
        self.assertEqual(state["keys"]["best"], {"kind": "value"})

    def test_options(self) -> None:
        pause = self.doc["panels"]["pause"]
        self.assertEqual((pause["modal"], pause["layer"], pause["html"]), (True, "menu", "ui/pause.html"))
        self.assertEqual(pause["scale"], "design")
        self.assertNotIn("scale", self.doc["panels"]["hud"], "the default is the runtime's")
        self.assertEqual(pause["toggle_with"], {"action_set": "game.actions.Controls", "action": "pause"})
        self.assertEqual(pause["state"], {"kind": "object", "keys": {}, "open": False})
        self.assertIsNone(self.doc["panels"]["over"]["state"], "a computed state() is dynamic")
        self.assertEqual(self.doc["panels"]["over"]["delay"], 0.5)

    def test_scene_commands_are_action_values_only(self) -> None:
        doc = extract({"game/ui.py": '''
            from parallax import Panel, load_scene, reload_scene, ui
            from project import Scenes

            def quit_to_title(ctx):
                return load_scene(Scenes.title, new_run=True)

            @ui("menu", html="ui/menu.html")
            class Menu(Panel):
                actions = {"quit": quit_to_title, "retry": reload_scene(reset="run")}
        '''})
        self.assertIn("ctx.scenes.load", diagnostic(doc, "PP3427")["fix"])
        self.assertIn("new_run=True", diagnostic(doc, "PP1103")["fix"])

    def test_builtin_panel_subclasses_bind_its_keys(self) -> None:
        doc = extract({"game/ui.py": '''
            from parallax import ui
            from parallax.hud import ComboPanel, MinimapPanel

            @ui("corner", html="ui/corner.html")
            class Corner(MinimapPanel):
                pass

            @ui("big", html="ui/big.html")
            class Big(MinimapPanel):
                def state(self, ctx, player):
                    """Pass-through."""
                    return super().state(ctx, player)

            class Restyled(ComboPanel):
                pass

            @ui("combo", html="ui/combo.html")
            class Combo(Restyled):
                pass

            @ui("zoomed", html="ui/zoomed.html")
            class Zoomed(MinimapPanel):
                def state(self, ctx, player):
                    return {"zoom": 2}
        '''})
        corner = doc["panels"]["corner"]["state"]
        self.assertFalse(corner["open"])
        self.assertIn("player_turn", corner["keys"])
        self.assertEqual(set(corner["keys"]["icons"]["item"]["keys"]), {"icon", "glyph", "x", "y", "color", "size", "turn", "label", "edge"})
        self.assertEqual(doc["panels"]["big"]["state"], corner)
        self.assertEqual(set(doc["panels"]["combo"]["state"]["keys"]), {"shown", "count", "best", "fill", "a11y"})
        self.assertEqual(set(doc["panels"]["zoomed"]["state"]["keys"]), {"zoom"})

    def test_panel_rules(self) -> None:
        messages = [d["message"] for d in self.doc["diagnostics"] if d["code"] == "PP4250"]
        self.assertTrue(any("opens one way" in m for m in messages))
        self.assertTrue(any("closes a when= panel" in m for m in messages))
        self.assertIn("not a button", diagnostic(self.doc, "PP4252")["message"])

    def test_action_sets(self) -> None:
        sets = self.doc["action_sets"]
        controls = sets["game.actions.Controls"]["actions"]
        self.assertEqual(controls["pause"]["bindings"]["keyboard"], ["KeyP", "Enter"])
        self.assertEqual(controls["slots"]["bindings"]["keyboard"], ["Digit1", None])
        p2 = sets["game.actions.Player2"]
        self.assertEqual((p2["priority"], p2["active_when"]), (1, True))
        self.assertEqual(set(p2["actions"]), {"move", "pause", "slots", "bad"})
        self.assertEqual(p2["actions"]["move"]["bindings"]["keyboard"], {"expr": 'keys.composite(up="KeyI", left="KeyJ", down="KeyK", right="Keyl")'.replace('"', "'")})
        unknown_keys = [d["message"] for d in self.doc["diagnostics"] if d["code"] == "PP4240"]
        self.assertEqual(sorted(unknown_keys), ['Unknown key "Keyl"', 'Unknown key "Spacebar"'])
        bad_bindings = [d["message"] for d in self.doc["diagnostics"] if d["code"] == "PP4241"]
        self.assertEqual(len(bad_bindings), 2)  # gamepad="South", touch.SWIPE

    def test_escape_cannot_be_bound(self) -> None:
        doc = extract({"game/actions.py": '''
            from parallax import Actions, axis1, axis2, button, gamepad, keys

            class Controls(Actions):
                pause = button(keyboard=("KeyP", "Escape"), gamepad=gamepad.START)
                back = button(keyboard="Escape")
                lean = axis1(negative="Escape", positive="KeyE")
                walk = axis2(keyboard=keys.composite(up="KeyW", left="KeyA", down="Escape", right="KeyD"))
                fine = button(keyboard="KeyP")
        '''})
        escapes = [d for d in doc["diagnostics"] if d["code"] == "PP4242"]
        self.assertEqual(len(escapes), 4)
        self.assertIn("cursor lock", escapes[0]["message"])
        self.assertIn("KeyP", escapes[0]["fix"])
        self.assertNotIn("PP4240", codes(doc))  # reported as Escape, not as an unknown key


class GameAndFeatures(unittest.TestCase):
    def test_game_pointer_lock_opt_out(self) -> None:
        doc = extract({
            "game/main.py": '''
                from parallax import Game
                from project import Scenes

                game = Game(id="g", title="G", sdk="1.0", mode="2d", start_scene=Scenes.main, pointer_lock=False)
            ''',
        }, with_main=False)
        self.assertNotIn("PP4005", codes(doc))
        self.assertIs(doc["game"]["pointer_lock"], False)

    def test_game_features_imports_refs_and_spawns(self) -> None:
        doc = extract({
            "game/main.py": '''
                from parallax import Game, plugins
                from project import Prefabs, Scenes
                from features.shop.feature import shop
                from game.logic import Core

                game = Game(id="g", title="G", sdk="1.0", mode="3d", start_scene=Scenes.town,
                            plugins=[plugins.physics3d(gravity=-20), plugins.local_players(seats=2, player_prefab=Prefabs.hero, controls="gamepads")],
                            features=[shop], systems=[Core])
            ''',
            "game/logic.py": '''
                from parallax import System, system
                from project import Content, Prefabs
                from game.data import Coin
                from features.shop.internal import price

                @system("core")
                class Core(System):
                    def start(self, ctx):
                        ctx.world.spawn(Prefabs.coin, components=[Coin(value=2)], params={"spin": {"rate": 1}})
                        ctx.world.spawn(Content.item.sword.data.prefab, components=[Coin()])
                        ctx.world.spawn(Prefabs.coin, components=self.extra())
            ''',
            "game/data.py": '''
                from parallax import component

                @component("coin")
                class Coin:
                    value: int = 1
            ''',
            "features/__init__.py": "",
            "features/shop/__init__.py": "",
            "features/shop/internal.py": "def price():\n    return 1\n",
            "features/shop/feature.py": '''
                from parallax import Feature
                from project import Scenes

                shop = Feature("store", requires=["inventory"], scenes=[Scenes.town], ui=[])
            ''',
        }, with_main=False)
        game = doc["game"]
        self.assertEqual((game["id"], game["mode"], game["start_scene"], game["systems"], game["features"]),
                         ("g", "3d", "town", ["core"], ["store"]))
        self.assertEqual(game["plugins"][0], {"id": "physics3d", "options": {"gravity": -20}, "line": game["plugins"][0]["line"]})
        self.assertEqual(game["plugins"][1]["options"]["player_prefab"], "hero")
        feature = doc["features"]["store"]
        self.assertEqual((feature["folder"], feature["requires"]), ("shop", ["inventory"]))
        self.assertIn("PP1105", codes(doc))  # id differs from its folder
        self.assertIn("ui", diagnostic(doc, "PP4005")["message"])
        imports = [i["module"] for i in doc["modules"]["game.logic"]["imports"]]
        self.assertIn("features.shop.internal", imports)
        refs = {tuple(r["ref"]) for r in doc["project_refs"]}
        self.assertIn(("Prefabs", "coin"), refs)
        self.assertIn(("Content", "item", "sword", "data", "prefab"), refs)
        spawns = [(s["prefab"], s["components"], s["params"]) for s in doc["spawns"]]
        self.assertEqual(spawns, [("coin", ["coin"], ["spin"]), (None, ["coin"], []), ("coin", None, [])])

    def test_missing_game(self) -> None:
        doc = extract({}, with_main=False)
        self.assertIsNone(doc["game"])
        self.assertIn("PP1101", codes(doc))

    def test_syntax_error_is_reported_and_the_rest_extracted(self) -> None:
        doc = extract({"game/broken.py": "def (:\n", "game/data.py": "from parallax import tag\nA = tag('a')\n"})
        self.assertIn("PP1100", codes(doc))
        self.assertIn("a", doc["tags"])


class Examples(unittest.TestCase):
    def test_brick_breaker(self) -> None:
        doc = extract_project(EXAMPLES / "brick_breaker")
        self.assertEqual(doc["diagnostics"], [])
        self.assertEqual(doc["game"]["systems"], ["upgrades", "stages", "scoring", "outcome", "feedback"])
        self.assertEqual([p["id"] for p in doc["game"]["plugins"]], ["physics3d", "combat", "grid"])
        self.assertEqual(set(doc["behaviors"]), {"prism_brick", "orb", "paddle_control"})
        self.assertEqual(doc["behaviors"]["prism_brick"]["requires"], ["health", "shape"])
        self.assertEqual(set(doc["panels"]), {"title_screen", "pause_menu", "hud", "draft", "game_over"})
        self.assertEqual(doc["content"]["stage"]["order"], "number")
        self.assertEqual(doc["resources"]["best"]["keep"], "profile")


if __name__ == "__main__":
    unittest.main()
