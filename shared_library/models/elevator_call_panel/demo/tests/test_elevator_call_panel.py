from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("elevator_call_panel: the prefab spawns and its model's controls work")
async def test_elevator_call_panel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.elevator_call_panel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("call_up", 0.0018)
    assert abs(model.joint("call_up") - 0.0018) < 1e-3
    model.set_option("metal", "nickel")
    assert model.option("metal") == "nickel"
    assert model.socket_position("press_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
