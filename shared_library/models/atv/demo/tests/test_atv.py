from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("atv: the prefab spawns and its model's controls work")
async def test_atv(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.atv, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steering", 0.0)
    assert abs(model.joint("steering") - 0.0) < 1e-3
    model.set_option("plastics", "blue")
    assert model.option("plastics") == "blue"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
