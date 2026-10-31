from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spell_altar: the prefab spawns and its model's controls work")
async def test_spell_altar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spell_altar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("runes", 30.0)
    assert abs(model.joint("runes") - 30.0) < 1e-3
    assert model.socket_position("socket_offering").distance_to(thing.transform.position) < 3.65
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
