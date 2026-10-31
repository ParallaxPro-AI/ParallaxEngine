from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("xray_machine: the prefab spawns and its model's controls work")
async def test_xray_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.xray_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stand_travel", -0.35)
    assert abs(model.joint("stand_travel") - -0.35) < 1e-3
    model.set_option("accent", "teal")
    assert model.option("accent") == "teal"
    assert model.socket_position("socket_patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
