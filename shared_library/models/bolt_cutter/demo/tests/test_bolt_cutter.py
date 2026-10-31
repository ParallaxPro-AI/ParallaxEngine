from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bolt_cutter: the prefab spawns and its model's controls work")
async def test_bolt_cutter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bolt_cutter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("handle_r", 5.5)
    assert abs(model.joint("handle_r") - 5.5) < 1e-3
    model.set_option("paint", "black")
    assert model.option("paint") == "black"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
