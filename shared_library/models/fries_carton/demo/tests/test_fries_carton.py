from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fries_carton: the prefab spawns and its model's controls work")
async def test_fries_carton(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fries_carton, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("carton", "white")
    assert model.option("carton") == "white"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
