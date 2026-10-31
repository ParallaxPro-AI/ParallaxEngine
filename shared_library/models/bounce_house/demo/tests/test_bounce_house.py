from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bounce_house: the prefab spawns and its model's controls work")
async def test_bounce_house(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bounce_house, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("deflate", 0.54)
    assert abs(model.joint("deflate") - 0.54) < 1e-3
    model.set_option("main_colour", "green")
    assert model.option("main_colour") == "green"
    assert model.socket_position("blower_inlet").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
