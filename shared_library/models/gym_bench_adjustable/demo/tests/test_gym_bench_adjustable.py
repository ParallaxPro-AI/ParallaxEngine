from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gym_bench_adjustable: the prefab spawns and its model's controls work")
async def test_gym_bench_adjustable(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gym_bench_adjustable, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("seat", 9.0)
    assert abs(model.joint("seat") - 9.0) < 1e-3
    model.set_option("leg_hold", "off")
    assert model.option("leg_hold") == "off"
    assert model.socket_position("seat_user").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
