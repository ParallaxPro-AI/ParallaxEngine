from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fridge: the prefab spawns and its model's controls work")
async def test_fridge(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fridge, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fridge_door", 57.5)
    assert abs(model.joint("fridge_door") - 57.5) < 1e-3
    model.set_option("finish", "white")
    assert model.option("finish") == "white"
    assert model.socket_position("socket_shelf_top").distance_to(thing.transform.position) < 3.11
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
