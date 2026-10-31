from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shield_kite: the prefab spawns and its model's controls work")
async def test_shield_kite(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shield_kite, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm_straps", 17.5)
    assert abs(model.joint("arm_straps") - 17.5) < 1e-3
    model.set_option("heraldry", "blue")
    assert model.option("heraldry") == "blue"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
