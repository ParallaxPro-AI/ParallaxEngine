from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("garden_swing_bench: the prefab spawns and its model's controls work")
async def test_garden_swing_bench(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.garden_swing_bench, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("canopy", 0.0)
    assert abs(model.joint("canopy") - 0.0) < 1e-3
    model.set_option("fabric", "green")
    assert model.option("fabric") == "green"
    assert model.socket_position("seat_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
