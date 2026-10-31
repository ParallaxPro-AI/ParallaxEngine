from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spell_orb: the prefab spawns and its model's controls work")
async def test_spell_orb(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spell_orb, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("element", "fire")
    assert model.option("element") == "fire"
    assert model.socket_position("socket_core").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
