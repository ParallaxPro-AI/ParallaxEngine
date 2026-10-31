"""Annotations → kernel FieldType JSON, and static defaults → authored JSON."""

import unittest

from parallax_transpiler.extract.tests.helpers import codes, diagnostic, extract


class FieldTypes(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = extract({"game/data.py": '''
            from enum import Enum
            from typing import Literal
            from parallax import (Color, ContentRef, Entity, Localized, PrefabRef, SoundRef, Tag, Vec2, Vec3,
                                  component, content, field, record, resource)
            from parallax.values import Cell

            class Ring(Enum):
                BULL = "bull"
                OUTER = "outer"

            Pair = tuple[float, float]

            @record
            class Wave:
                title: Localized
                count: int = field(1, min=1)

            @content("enemy", order="tier")
            class EnemyDef:
                tier: int
                name: Localized
                next: ContentRef["EnemyDef"] | None = field(None)
                waves: list[Wave] = field([])
                prefab: PrefabRef = field("slime")

            @component("kit")
            class Kit:
                speed: float = 2.5
                lives: int = field(3, min=0, max=9, unit="lives", doc="Spare lives.")
                alive: bool = True
                label: str = ""
                at: Vec2 = Vec2(1, 2)
                up: Vec3 = Vec3.UP
                tint: Color = Color.hex("#ff8800")
                fade: Color = Color.hex("#ffffff").with_alpha(0.5)
                kind: Tag = field("enemy")
                target: Entity | None = None
                ring: Ring = Ring.BULL
                side: Literal["left", "right"] = "left"
                tags: list[str] = field([])
                scores: dict[str, int] = field({})
                maybe: float | None = None
                hit: SoundRef = field("sfx/hit")
                pair: Pair = (0.0, 1.0)
                cell: Cell = Cell(1, 2)
                half: float = 1 / 2
                big: Vec3 = Vec3.ONE * 2
                required: float = field(min=1)
        '''})

    def fields(self, section: str, ident: str) -> dict:
        return self.doc[section][ident]["fields"]

    def test_scalars_and_values(self) -> None:
        kit = self.fields("components", "kit")
        self.assertEqual(kit["speed"]["type"], {"kind": "number"})
        self.assertEqual(kit["speed"]["default"], 2.5)
        self.assertEqual(kit["lives"]["type"], {"kind": "int"})
        self.assertEqual((kit["lives"]["min"], kit["lives"]["max"], kit["lives"]["unit"], kit["lives"]["doc"]),
                         (0, 9, "lives", "Spare lives."))
        self.assertEqual(kit["alive"]["type"], {"kind": "bool"})
        self.assertEqual(kit["label"]["type"], {"kind": "string"})
        self.assertEqual((kit["at"]["type"], kit["at"]["default"]), ({"kind": "vec2"}, [1, 2]))
        self.assertEqual((kit["up"]["type"], kit["up"]["default"]), ({"kind": "vec3"}, [0, 1, 0]))
        self.assertEqual((kit["tint"]["type"], kit["tint"]["default"]), ({"kind": "color"}, "#ff8800"))
        self.assertEqual(kit["fade"]["default"], [1.0, 1.0, 1.0, 0.5])
        self.assertEqual(kit["kind"]["type"], {"kind": "tag"})
        self.assertEqual(kit["target"]["type"], {"kind": "optional", "of": {"kind": "entity"}})
        self.assertEqual(kit["half"]["default"], 0.5)
        self.assertEqual(kit["big"]["default"], [2, 2, 2])
        self.assertNotIn("default", kit["required"])
        self.assertEqual(kit["required"]["min"], 1)

    def test_enums_literals_and_containers(self) -> None:
        kit = self.fields("components", "kit")
        self.assertEqual(kit["ring"]["type"], {"kind": "enum", "values": ["bull", "outer"]})
        self.assertEqual(kit["ring"]["default"], "bull")
        self.assertEqual(kit["side"]["type"], {"kind": "enum", "values": ["left", "right"]})
        self.assertEqual(kit["tags"]["type"], {"kind": "list", "of": {"kind": "string"}})
        self.assertEqual(kit["scores"]["type"], {"kind": "dict", "of": {"kind": "int"}})
        self.assertEqual(kit["maybe"]["type"], {"kind": "optional", "of": {"kind": "number"}})
        self.assertEqual(kit["hit"]["type"], {"kind": "ref", "to": "asset/sfx"})

    def test_refs_records_and_localized_paths(self) -> None:
        enemy = self.doc["content"]["enemy"]
        self.assertEqual(enemy["order"], "tier")
        self.assertEqual(enemy["fields"]["next"]["type"], {"kind": "optional", "of": {"kind": "ref", "to": "content/enemy"}})
        self.assertEqual(enemy["fields"]["prefab"]["type"], {"kind": "ref", "to": "prefab"})
        waves = enemy["fields"]["waves"]["type"]
        self.assertEqual(waves["kind"], "list")
        self.assertEqual(waves["of"]["kind"], "record")
        self.assertEqual(waves["of"]["fields"]["count"]["type"], {"kind": "int"})
        self.assertEqual(waves["of"]["fields"]["count"]["default"], 1)
        self.assertEqual(enemy["fields"]["name"]["type"], {"kind": "string"})
        self.assertEqual(sorted(enemy["localized"]), ["name", "waves[].title"])
        self.assertIn("game.data.Wave", self.doc["records"])
        self.assertIn("game.data.Ring", self.doc["enums"])

    def test_approximations_are_listed_not_silent(self) -> None:
        kit = self.fields("components", "kit")
        self.assertEqual(kit["pair"]["type"], {"kind": "list", "of": {"kind": "number"}})
        self.assertEqual(kit["cell"]["type"], {"kind": "list", "of": {"kind": "int"}})
        self.assertEqual(kit["cell"]["default"], [1, 2])
        notes = {a["field"] for a in self.doc["approximations"] if a["path"].startswith("game/")}
        self.assertEqual(notes, {"Kit.pair", "Kit.cell"})

    def test_clean(self) -> None:
        self.assertEqual(codes(self.doc), [])


class Defaults(unittest.TestCase):
    def test_records_timers_constants_and_refs(self) -> None:
        doc = extract({"game/data.py": '''
            from parallax import Behavior, PrefabRef, Timer, behavior, field, param, record, resource, state
            from project import Prefabs

            BASE = 4
            SCALE = BASE * 2

            @record
            class Ingredient:
                name: str
                count: int = field(1)

            @resource("kitchen")
            class Kitchen:
                first: Ingredient = Ingredient("salt")
                size: int = SCALE
                spawn: PrefabRef = Prefabs.chef

            @behavior("cook")
            class Cook(Behavior):
                cooldown: Timer = state(Timer.cooldown(0.5))
                delay: Timer = state(Timer.delay(2, repeat=True))
                explicit: Timer = state(Timer(1, start_done=False))
        '''})
        kitchen = doc["resources"]["kitchen"]["fields"]
        self.assertEqual(kitchen["first"]["default"], {"name": "salt", "count": 1})
        self.assertEqual(kitchen["size"]["default"], 8)
        self.assertEqual(kitchen["spawn"]["default"], "chef")
        state = doc["behaviors"]["cook"]["state"]
        self.assertEqual(state["cooldown"]["default"], {"duration": 0.5, "remaining": 0, "repeat": False})
        self.assertEqual(state["delay"]["default"], {"duration": 2, "remaining": 2, "repeat": True})
        self.assertEqual(state["explicit"]["default"], {"duration": 1, "remaining": 1, "repeat": False})
        self.assertEqual(state["cooldown"]["type"]["kind"], "record")

    def test_unreadable_default_is_a_warning_with_the_expression(self) -> None:
        doc = extract({"game/data.py": '''
            from parallax import component, field

            def compute():
                return 3

            @component("c")
            class C:
                n: int = field(compute())
        '''})
        d = diagnostic(doc, "PP4002")
        self.assertEqual(d["severity"], "warning")
        self.assertEqual(doc["components"]["c"]["fields"]["n"]["default_expr"], "compute()")

    def test_unsupported_type_and_non_str_enum(self) -> None:
        doc = extract({"game/data.py": '''
            from enum import Enum
            from parallax import component, field

            class Level(Enum):
                LOW = 1

            class Plain:
                pass

            @component("c")
            class C:
                level: Level = field(None)
                thing: Plain = field(None)
        '''})
        self.assertIn("PP4003", codes(doc))
        self.assertIn("PP4001", codes(doc))
        self.assertNotIn("thing", doc["components"]["c"]["fields"])


if __name__ == "__main__":
    unittest.main()
