from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stun_baton: the prefab spawns and its model's controls work")
async def test_stun_baton(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stun_baton, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("power_switch", 0.006)
    assert abs(model.joint("power_switch") - 0.006) < 1e-3
    model.set_option("arc", "discharging")
    assert model.option("arc") == "discharging"
    assert model.socket_position("arc").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
