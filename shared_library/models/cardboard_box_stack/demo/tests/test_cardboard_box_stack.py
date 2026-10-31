from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cardboard_box_stack: the prefab spawns and its model's controls work")
async def test_cardboard_box_stack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cardboard_box_stack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("d_flap_front", 115.0)
    assert abs(model.joint("d_flap_front") - 115.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
