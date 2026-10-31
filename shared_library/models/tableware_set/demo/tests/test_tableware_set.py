from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tableware_set: the prefab spawns and its model's controls work")
async def test_tableware_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tableware_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("pieces", "dinner")
    assert model.option("pieces") == "dinner"
    assert model.socket_position("socket_plate").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
