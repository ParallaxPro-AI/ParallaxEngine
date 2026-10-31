"""Behaviors, systems, events and data decorators: ids, options, hooks, handlers and the
rules the extract pass enforces (PP42xx)."""

import unittest

from parallax_transpiler.extract.tests.helpers import codes, diagnostic, extract


class Behaviors(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = extract({"game/logic.py": '''
            from parallax import Behavior, Collided, behavior, on, param, state
            from parallax.physics import Rigidbody
            from game.data import Lane

            @behavior("runner", requires=[Rigidbody, Lane], tick=10, when=lambda ctx: True)
            class Runner(Behavior):
                """Runs."""
                speed: float = param(4, unit="m/s")
                lane: int = param()
                timer: float = state(0.0)
                loose: int = 3

                def start(self, ctx):
                    self.timer = 0
                    self.speed = 9
                    self.ghost = 1
                    self.helper()

                def updte(self, ctx, dt):
                    pass

                def late_update(self, ctx):
                    pass

                def helper(self):
                    pass

                @on(Collided, where=lambda e: True)
                def bumped(self, ctx, event):
                    pass
        ''', "game/data.py": '''
            from parallax import component

            @component("lane")
            class Lane:
                index: int = 0
        '''})
        self.runner = self.doc["behaviors"]["runner"]

    def test_declaration(self) -> None:
        r = self.runner
        self.assertEqual(r["requires"], ["rigidbody", "lane"])
        self.assertEqual(r["tick"], 10)
        self.assertTrue(r["when"])
        self.assertEqual(list(r["params"]), ["speed", "lane"])
        self.assertEqual(r["params"]["speed"]["default"], 4)
        self.assertNotIn("default", r["params"]["lane"])
        self.assertEqual(list(r["state"]), ["timer"])
        self.assertEqual(r["hooks"], ["start", "late_update"])
        self.assertEqual(r["handlers"], [{"method": "bumped", "line": r["handlers"][0]["line"], "event": "collided", "where": True}])
        self.assertEqual(r["doc"], "Runs.")

    def test_rules(self) -> None:
        self.assertIn("Behavior field 'loose'", diagnostic(self.doc, "PP4223")["message"])
        self.assertIn("'speed' is a param", diagnostic(self.doc, "PP4222")["message"])
        self.assertIn("self.ghost", diagnostic(self.doc, "PP4221")["message"])
        self.assertIn("did you mean 'update'", diagnostic(self.doc, "PP4210")["message"])
        self.assertIn("late_update", diagnostic(self.doc, "PP4212")["message"])
        self.assertEqual(codes(self.doc).count("PP4210"), 1, "helper() is called, so it is not a misspelled hook")


class Systems(unittest.TestCase):
    def test_declaration_and_no_fields(self) -> None:
        doc = extract({"game/logic.py": '''
            from parallax import System, on, system, tag
            from project import Scenes
            from game.events import Scored

            Level = tag("level")

            @system("first")
            class First(System):
                pass

            @system("second", scenes=[Scenes.arena, Level], after=[First], runs_while_frozen=True, runs_on="everywhere")
            class Second(System):
                count: int = 0

                def update(self, ctx, dt):
                    self.total = 1

                @on(Scored, always=True)
                def scored(self, ctx, event):
                    pass

            @system("idle", when=lambda ctx: True)
            class Idle(System):
                pass
        ''', "game/events.py": '''
            from parallax import Entity, event

            @event("scored", target="by")
            class Scored:
                by: Entity
                points: int = 1

            @event("broken", target="points")
            class Broken:
                points: int
        '''})
        second = doc["systems"]["second"]
        self.assertEqual([{k: v for k, v in s.items() if k != "line"} for s in second["scenes"]], [{"scene": "arena"}, {"tag": "level"}])
        self.assertEqual(second["after"], ["first"])
        self.assertEqual((second["runs_while_frozen"], second["runs_on"]), (True, "everywhere"))
        self.assertEqual(second["handlers"][0]["always"], True)
        self.assertEqual(codes(doc).count("PP4220"), 2)
        self.assertEqual(doc["events"]["scored"]["target"], "by")
        self.assertIn("Entity field", diagnostic(doc, "PP4008")["message"])
        self.assertEqual(diagnostic(doc, "PP4230")["severity"], "warning")
        self.assertEqual(doc["tags"]["level"]["name"], "Level")


class DataDecorators(unittest.TestCase):
    def test_rules(self) -> None:
        doc = extract({"game/data.py": '''
            from parallax import component, config, content, field, resource

            @component("hp")
            class Hp:
                value: int = field(1, keep="run")

                def heal(self):
                    pass

            @resource("best", keep="profile")
            class Best:
                score: int = 0
                session_pick: str = field("", keep="session")

                def double(self):
                    pass

            @config("rules", colour="red")
            class Rules:
                lives: int = 3

            @content("level", order="nmber")
            class LevelDef:
                number: int

            @component("hp")
            class Duplicate:
                pass
        '''})
        self.assertEqual(codes(doc).count("PP4201"), 2)
        self.assertIn("Resource Best defines method 'double'", [d["message"] for d in doc["diagnostics"] if d["code"] == "PP4201"][1])
        self.assertIn("keep= applies to resource fields", diagnostic(doc, "PP4006")["message"])
        fields = doc["resources"]["best"]["fields"]
        self.assertEqual((fields["score"]["keep"], fields["session_pick"]["keep"]), ("profile", "session"))
        self.assertIn("colour", diagnostic(doc, "PP4005")["message"])
        self.assertIn('Did you mean "number"', diagnostic(doc, "PP4007")["fix"])
        self.assertIn("already declared", diagnostic(doc, "PP1104")["message"])

    def test_builtin_content_kind_extension(self) -> None:
        doc = extract({"game/quests.py": '''
            from parallax import content, field
            from parallax.story import QuestDef

            @content("quest", order="chapter")
            class Chapter(QuestDef):
                chapter: int = field(0)
        '''})
        quest = doc["content"]["quest"]
        self.assertEqual(quest["extends"], "quest")
        self.assertIn("steps", quest["fields"])
        self.assertIn("chapter", quest["fields"])
        self.assertIn("steps{}.text", quest["localized"])

    def test_engine_section_comes_from_the_sdk_stubs(self) -> None:
        doc = extract({})
        engine = doc["engine"]
        self.assertEqual(engine["components"]["rigidbody"]["plugins"], ["physics2d", "physics3d"])
        self.assertEqual(engine["components"]["sprite"]["plugins"], ["core"])
        self.assertTrue(engine["components"]["collider"]["fields"]["radius"]["engine_default"])
        self.assertEqual(engine["components"]["grid"]["fields"]["cols"]["default"], 8)
        self.assertEqual(engine["events"]["collided"]["target"], "entity")
        self.assertIn("quest", engine["content"])
        self.assertEqual(codes(doc), [])


if __name__ == "__main__":
    unittest.main()
