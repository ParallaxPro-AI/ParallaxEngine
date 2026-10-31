from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("covered_wagon: the prefab spawns and its model's controls work")
async def test_covered_wagon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.covered_wagon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("end_gate", 62.015)
    assert abs(model.joint("end_gate") - 62.015) < 1e-3
    model.set_option("bed_paint", "green")
    assert model.option("bed_paint") == "green"
    assert model.socket_position("socket_hitch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
