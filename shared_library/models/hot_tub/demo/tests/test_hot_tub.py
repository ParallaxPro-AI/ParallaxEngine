from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hot_tub: the prefab spawns and its model's controls work")
async def test_hot_tub(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hot_tub, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cover_lift", 47.5)
    assert abs(model.joint("cover_lift") - 47.5) < 1e-3
    model.set_option("cabinet", "grey")
    assert model.option("cabinet") == "grey"
    assert model.socket_position("socket_water").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
