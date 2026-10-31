from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ice_cream_van: the prefab spawns and its model's controls work")
async def test_ice_cream_van(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ice_cream_van, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 72.5)
    assert abs(model.joint("hatch") - 72.5) < 1e-3
    model.set_option("paint", "mint")
    assert model.option("paint") == "mint"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
