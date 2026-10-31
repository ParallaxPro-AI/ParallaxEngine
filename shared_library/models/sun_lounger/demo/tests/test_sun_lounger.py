from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sun_lounger: the prefab spawns and its model's controls work")
async def test_sun_lounger(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sun_lounger, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("backrest", 40.0)
    assert abs(model.joint("backrest") - 40.0) < 1e-3
    model.set_option("cushions", "bare")
    assert model.option("cushions") == "bare"
    assert model.socket_position("socket_lie").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
