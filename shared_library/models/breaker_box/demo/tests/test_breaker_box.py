from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("breaker_box: the prefab spawns and its model's controls work")
async def test_breaker_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.breaker_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("main_toggle", 0.0)
    assert abs(model.joint("main_toggle") - 0.0) < 1e-3
    model.set_option("mount", "bare")
    assert model.option("mount") == "bare"
    assert model.socket_position("socket_operator").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
