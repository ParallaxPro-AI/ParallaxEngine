from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("desk_lamp: the prefab spawns and its model's controls work")
async def test_desk_lamp(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.desk_lamp, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm_lower", 25.0)
    assert abs(model.joint("arm_lower") - 25.0) < 1e-3
    model.set_option("style", "bankers")
    assert model.option("style") == "bankers"
    assert model.socket_position("socket_bulb").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
