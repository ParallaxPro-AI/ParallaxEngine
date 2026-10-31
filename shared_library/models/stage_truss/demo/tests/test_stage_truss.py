from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stage_truss: the prefab spawns and its model's controls work")
async def test_stage_truss(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stage_truss, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tilt_0", 22.5)
    assert abs(model.joint("tilt_0") - 22.5) < 1e-3
    model.set_option("gel", "cool")
    assert model.option("gel") == "cool"
    assert model.socket_position("socket_span_mid").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
