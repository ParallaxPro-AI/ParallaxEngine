from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pizza_oven_brick: the prefab spawns and its model's controls work")
async def test_pizza_oven_brick(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pizza_oven_brick, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("oven_door", 55.0)
    assert abs(model.joint("oven_door") - 55.0) < 1e-3
    model.set_option("dome_finish", "render")
    assert model.option("dome_finish") == "render"
    assert model.socket_position("oven_floor").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
