from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("monorail_car: the prefab spawns and its model's controls work")
async def test_monorail_car(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.monorail_car, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_lf", 0.625)
    assert abs(model.joint("door_lf") - 0.625) < 1e-3
    model.set_option("stripe", "red")
    assert model.option("stripe") == "red"
    assert model.socket_position("socket_coupler_rear").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
