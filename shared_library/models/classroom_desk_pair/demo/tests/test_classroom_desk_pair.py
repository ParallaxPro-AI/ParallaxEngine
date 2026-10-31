from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("classroom_desk_pair: the prefab spawns and its model's controls work")
async def test_classroom_desk_pair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.classroom_desk_pair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("chair_l", 0.15)
    assert abs(model.joint("chair_l") - 0.15) < 1e-3
    model.set_option("frame_colour", "blue")
    assert model.option("frame_colour") == "blue"
    assert model.socket_position("seat_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
