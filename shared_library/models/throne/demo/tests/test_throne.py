from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("throne: the prefab spawns and its model's controls work")
async def test_throne(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.throne, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "gilded")
    assert model.option("finish") == "gilded"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 3.9
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
