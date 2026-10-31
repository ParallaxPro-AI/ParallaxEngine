from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dwarf_warrior: the prefab spawns and its model's controls work")
async def test_dwarf_warrior(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dwarf_warrior, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("skin", "pale")
    assert model.option("skin") == "pale"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
