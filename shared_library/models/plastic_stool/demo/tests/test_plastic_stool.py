from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plastic_stool: the prefab spawns and its model's controls work")
async def test_plastic_stool(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plastic_stool, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("colour", "blue")
    assert model.option("colour") == "blue"
    assert model.socket_position("seat_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
