from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pizza: the prefab spawns and its model's controls work")
async def test_pizza(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pizza, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("slice", 0.05)
    assert abs(model.joint("slice") - 0.05) < 1e-3
    model.set_option("toppings", "margherita")
    assert model.option("toppings") == "margherita"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
