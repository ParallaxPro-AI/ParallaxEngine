from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("airport_control_tower: the prefab spawns and its model's controls work")
async def test_airport_control_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.airport_control_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("chair_n_0_lift", 0.05)
    assert abs(model.joint("chair_n_0_lift") - 0.05) < 1e-3
    model.set_option("accent", "orange")
    assert model.option("accent") == "orange"
    assert model.socket_position("socket_entrance").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
