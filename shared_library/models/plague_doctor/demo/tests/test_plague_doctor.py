from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plague_doctor: the prefab spawns and its model's controls work")
async def test_plague_doctor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plague_doctor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("coat", "brown")
    assert model.option("coat") == "brown"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
