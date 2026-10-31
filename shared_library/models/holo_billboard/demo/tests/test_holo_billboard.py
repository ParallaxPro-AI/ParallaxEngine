from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("holo_billboard: the prefab spawns and its model's controls work")
async def test_holo_billboard(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.holo_billboard, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cabinet_door", 50.0)
    assert abs(model.joint("cabinet_door") - 50.0) < 1e-3
    model.set_option("hologram", "magenta")
    assert model.option("hologram") == "magenta"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
