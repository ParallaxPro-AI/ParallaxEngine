from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rickshaw: the prefab spawns and its model's controls work")
async def test_rickshaw(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rickshaw, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hood", 21.0)
    assert abs(model.joint("hood") - 21.0) < 1e-3
    model.set_option("body_paint", "red")
    assert model.option("body_paint") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
