from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hospital_bed: the prefab spawns and its model's controls work")
async def test_hospital_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hospital_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("deck_lift", 0.11)
    assert abs(model.joint("deck_lift") - 0.11) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
