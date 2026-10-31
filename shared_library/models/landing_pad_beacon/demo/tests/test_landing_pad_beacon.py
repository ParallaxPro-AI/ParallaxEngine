from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("landing_pad_beacon: the prefab spawns and its model's controls work")
async def test_landing_pad_beacon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.landing_pad_beacon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("signal", "green")
    assert model.option("signal") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
