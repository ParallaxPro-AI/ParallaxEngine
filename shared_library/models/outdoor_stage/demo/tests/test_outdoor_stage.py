from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("outdoor_stage: the prefab spawns and its model's controls work")
async def test_outdoor_stage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.outdoor_stage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("truss_front_tilt_0", 22.5)
    assert abs(model.joint("truss_front_tilt_0") - 22.5) < 1e-3
    model.set_option("drape", "blue")
    assert model.option("drape") == "blue"
    assert model.socket_position("socket_centre_stage").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
