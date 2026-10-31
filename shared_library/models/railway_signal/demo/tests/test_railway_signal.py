from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("railway_signal: the prefab spawns and its model's controls work")
async def test_railway_signal(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.railway_signal, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm", 22.5)
    assert abs(model.joint("arm") - 22.5) < 1e-3
    model.set_option("aspect", "colour_danger")
    assert model.option("aspect") == "colour_danger"
    assert model.socket_position("track_side").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
