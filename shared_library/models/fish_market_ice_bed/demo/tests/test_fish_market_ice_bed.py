from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fish_market_ice_bed: the prefab spawns and its model's controls work")
async def test_fish_market_ice_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fish_market_ice_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("body", "white")
    assert model.option("body") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
