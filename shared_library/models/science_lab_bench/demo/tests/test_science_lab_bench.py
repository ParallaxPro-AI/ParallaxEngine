from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("science_lab_bench: the prefab spawns and its model's controls work")
async def test_science_lab_bench(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.science_lab_bench, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_f0", 52.5)
    assert abs(model.joint("door_f0") - 52.5) < 1e-3
    model.set_option("doors", "beech")
    assert model.option("doors") == "beech"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
