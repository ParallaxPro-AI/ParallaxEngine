from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("semi_trailer: the prefab spawns and its model's controls work")
async def test_semi_trailer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.semi_trailer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 62.5)
    assert abs(model.joint("door_l") - 62.5) < 1e-3
    model.set_option("body", "skeletal")
    assert model.option("body") == "skeletal"
    assert model.socket_position("socket_kingpin").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
