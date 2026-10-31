from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stagecoach: the prefab spawns and its model's controls work")
async def test_stagecoach(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stagecoach, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 50.0)
    assert abs(model.joint("door_l") - 50.0) < 1e-3
    model.set_option("body_paint", "green")
    assert model.option("body_paint") == "green"
    assert model.socket_position("socket_hitch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
