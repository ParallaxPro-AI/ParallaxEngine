from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("party_balloon_arch: the prefab spawns and its model's controls work")
async def test_party_balloon_arch(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.party_balloon_arch, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("color_a", "gold")
    assert model.option("color_a") == "gold"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
