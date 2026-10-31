from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("railway_platform: the prefab spawns and its model's controls work")
async def test_railway_platform(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.railway_platform, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("edges", "island")
    assert model.option("edges") == "island"
    assert model.socket_position("track_a").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
