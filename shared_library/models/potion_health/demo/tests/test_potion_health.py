from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("potion_health: the prefab spawns and its model's controls work")
async def test_potion_health(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.potion_health, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("liquid_colour", "mana")
    assert model.option("liquid_colour") == "mana"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
