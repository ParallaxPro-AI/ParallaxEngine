from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ambulance_stretcher: the prefab spawns and its model's controls work")
async def test_ambulance_stretcher(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ambulance_stretcher, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("backrest", 37.5)
    assert abs(model.joint("backrest") - 37.5) < 1e-3
    model.set_option("accent", "orange")
    assert model.option("accent") == "orange"
    assert model.socket_position("patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
