from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("basic_dining_chair: the prefab spawns and its model's controls work")
async def test_basic_dining_chair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.basic_dining_chair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("pad", "warm_grey")
    assert model.option("pad") == "warm_grey"
    assert model.socket_position("seat_center").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
