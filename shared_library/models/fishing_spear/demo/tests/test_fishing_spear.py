from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fishing_spear: the prefab spawns and its model's controls work")
async def test_fishing_spear(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fishing_spear, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("shaft_wood", "ash")
    assert model.option("shaft_wood") == "ash"
    assert model.socket_position("tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
