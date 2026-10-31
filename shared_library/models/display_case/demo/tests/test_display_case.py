from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("display_case: the prefab spawns and its model's controls work")
async def test_display_case(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.display_case, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("glass_left", 0.285)
    assert abs(model.joint("glass_left") - 0.285) < 1e-3
    assert model.socket_position("socket_shelf_bot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
