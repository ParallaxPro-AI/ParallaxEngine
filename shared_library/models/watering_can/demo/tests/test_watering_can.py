from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("watering_can: the prefab spawns and its model's controls work")
async def test_watering_can(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.watering_can, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "galvanised")
    assert model.option("finish") == "galvanised"
    assert model.socket_position("spout").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
