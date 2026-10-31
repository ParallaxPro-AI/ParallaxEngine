from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stock_car_racer: the prefab spawns and its model's controls work")
async def test_stock_car_racer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stock_car_racer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_fl", 33.0)
    assert abs(model.joint("door_fl") - 33.0) < 1e-3
    model.set_option("paint", "midnight")
    assert model.option("paint") == "midnight"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
