from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("street_sweeper: the prefab spawns and its model's controls work")
async def test_street_sweeper(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.street_sweeper, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_tilt", 26.0)
    assert abs(model.joint("cab_tilt") - 26.0) < 1e-3
    model.set_option("body", "parked")
    assert model.option("body") == "parked"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
