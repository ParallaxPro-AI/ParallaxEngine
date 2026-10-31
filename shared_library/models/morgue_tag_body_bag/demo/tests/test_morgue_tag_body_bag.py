from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("morgue_tag_body_bag: the prefab spawns and its model's controls work")
async def test_morgue_tag_body_bag(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.morgue_tag_body_bag, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("zip", 0.3)
    assert abs(model.joint("zip") - 0.3) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
