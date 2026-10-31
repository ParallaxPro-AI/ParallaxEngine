from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shop_security_gate: the prefab spawns and its model's controls work")
async def test_shop_security_gate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shop_security_gate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("status_light", "alarm")
    assert model.option("status_light") == "alarm"
    assert model.socket_position("socket_lane_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
