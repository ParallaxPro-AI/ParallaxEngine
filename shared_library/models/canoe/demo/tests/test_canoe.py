from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("canoe: the prefab spawns and its model's controls work")
async def test_canoe(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.canoe, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("colour", "red")
    assert model.option("colour") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
