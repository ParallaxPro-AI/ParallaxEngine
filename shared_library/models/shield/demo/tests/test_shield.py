from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shield: the prefab spawns and its model's controls work")
async def test_shield(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shield, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm_straps", 22.5)
    assert abs(model.joint("arm_straps") - 22.5) < 1e-3
    model.set_option("shape", "round")
    assert model.option("shape") == "round"
    assert model.socket_position("socket_boss").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
