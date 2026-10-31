from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("molotov_cocktail: the prefab spawns and its model's controls work")
async def test_molotov_cocktail(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.molotov_cocktail, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "lit")
    assert model.option("state") == "lit"
    assert model.socket_position("fire").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
