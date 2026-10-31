from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sawmill: the prefab spawns and its model's controls work")
async def test_sawmill(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sawmill, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("carriage", 4.3)
    assert abs(model.joint("carriage") - 4.3) < 1e-3
    model.set_option("roof", "rusty")
    assert model.option("roof") == "rusty"
    assert model.socket_position("siding").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
