from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cricket_set: the prefab spawns and its model's controls work")
async def test_cricket_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cricket_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stump_l", 17.5)
    assert abs(model.joint("stump_l") - 17.5) < 1e-3
    model.set_option("layout", "wicket")
    assert model.option("layout") == "wicket"
    assert model.socket_position("socket_wicket").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
