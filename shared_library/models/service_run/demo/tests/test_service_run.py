from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("service_run: the prefab spawns and its model's controls work")
async def test_service_run(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.service_run, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("run", "tray")
    assert model.option("run") == "tray"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
