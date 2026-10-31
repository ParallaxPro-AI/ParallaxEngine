from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("combine_harvester: the prefab spawns and its model's controls work")
async def test_combine_harvester(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.combine_harvester, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("auger", 46.0)
    assert abs(model.joint("auger") - 46.0) < 1e-3
    model.set_option("paint", "green")
    assert model.option("paint") == "green"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
