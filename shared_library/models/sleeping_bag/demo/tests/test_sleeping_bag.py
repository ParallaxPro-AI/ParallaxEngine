from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sleeping_bag: the prefab spawns and its model's controls work")
async def test_sleeping_bag(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sleeping_bag, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "rolled")
    assert model.option("state") == "rolled"
    assert model.socket_position("socket_sleeper").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
