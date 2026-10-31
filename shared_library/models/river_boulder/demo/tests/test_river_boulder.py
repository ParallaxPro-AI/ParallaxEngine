from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("river_boulder: the prefab spawns and its model's controls work")
async def test_river_boulder(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.river_boulder, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("wear", "wet")
    assert model.option("wear") == "wet"
    assert model.socket_position("socket_lee").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
