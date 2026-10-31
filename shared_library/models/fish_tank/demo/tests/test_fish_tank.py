from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fish_tank: the prefab spawns and its model's controls work")
async def test_fish_tank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fish_tank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("lid", "on")
    assert model.option("lid") == "on"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
