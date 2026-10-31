from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bellhop_stand: the prefab spawns and its model's controls work")
async def test_bellhop_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bellhop_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 47.5)
    assert abs(model.joint("lid") - 47.5) < 1e-3
    model.set_option("wood", "ebony")
    assert model.option("wood") == "ebony"
    assert model.socket_position("staff_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
