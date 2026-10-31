from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("power_substation: the prefab spawns and its model's controls work")
async def test_power_substation(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.power_substation, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate_l", 50.0)
    assert abs(model.joint("gate_l") - 50.0) < 1e-3
    assert model.socket_position("line_in_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
