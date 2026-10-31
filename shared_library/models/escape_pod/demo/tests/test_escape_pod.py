from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("escape_pod: the prefab spawns and its model's controls work")
async def test_escape_pod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.escape_pod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 50.0)
    assert abs(model.joint("hatch") - 50.0) < 1e-3
    model.set_option("hull_paint", "orange")
    assert model.option("hull_paint") == "orange"
    assert model.socket_position("seat_occupant").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
