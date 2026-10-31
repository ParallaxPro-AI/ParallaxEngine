from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("kitchen_bin: the prefab spawns and its model's controls work")
async def test_kitchen_bin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.kitchen_bin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pedal", 9.0)
    assert abs(model.joint("pedal") - 9.0) < 1e-3
    model.set_option("type", "swing")
    assert model.option("type") == "swing"
    assert model.socket_position("socket_contents").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
