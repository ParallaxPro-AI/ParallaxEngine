from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("duty_free_stand: the prefab spawns and its model's controls work")
async def test_duty_free_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.duty_free_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stock_door", 0.28)
    assert abs(model.joint("stock_door") - 0.28) < 1e-3
    model.set_option("finish", "black")
    assert model.option("finish") == "black"
    assert model.socket_position("socket_shopper_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
