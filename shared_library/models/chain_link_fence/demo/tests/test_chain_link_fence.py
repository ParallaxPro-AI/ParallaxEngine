from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chain_link_fence: the prefab spawns and its model's controls work")
async def test_chain_link_fence(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chain_link_fence, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("top", "barbed")
    assert model.option("top") == "barbed"
    assert model.socket_position("next_module").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
