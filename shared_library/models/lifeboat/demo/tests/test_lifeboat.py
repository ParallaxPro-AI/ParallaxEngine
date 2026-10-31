from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lifeboat: the prefab spawns and its model's controls work")
async def test_lifeboat(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lifeboat, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("side_hatch_l", 52.5)
    assert abs(model.joint("side_hatch_l") - 52.5) < 1e-3
    model.set_option("canopy", "red")
    assert model.option("canopy") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
