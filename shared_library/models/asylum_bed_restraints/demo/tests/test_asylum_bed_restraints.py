from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("asylum_bed_restraints: the prefab spawns and its model's controls work")
async def test_asylum_bed_restraints(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.asylum_bed_restraints, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("chest_strap", 50.0)
    assert abs(model.joint("chest_strap") - 50.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
