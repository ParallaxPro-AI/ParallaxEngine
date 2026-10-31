from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("exercise_bike: the prefab spawns and its model's controls work")
async def test_exercise_bike(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.exercise_bike, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("resistance_knob", 135.0)
    assert abs(model.joint("resistance_knob") - 135.0) < 1e-3
    model.set_option("frame_colour", "white")
    assert model.option("frame_colour") == "white"
    assert model.socket_position("seat_rider").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
