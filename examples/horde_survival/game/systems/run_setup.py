import random

from parallax import SceneLoaded, SurfaceFx, System, on, scatter, system, vec3
from project import Scenes, Text

from game.content import DecorDef
from game.effects import apply_effect
from game.heat import heat, ridged
from game.resources import Choices, Draft, Records
from game.rules import Rules, alert, survivor


@system("run_setup", scenes=[Scenes.arena])
class RunSetup(System):
    """Starts a run when the arena loads: remembers the seed, applies the shrine's perks
    to the survivor, dresses the arena from the seed and burns the Emberwarden in."""

    @on(SceneLoaded)
    def scene_loaded(self, ctx, event: SceneLoaded):
        ctx.get(Records).last_seed = ctx.seed
        ctx.get(Draft).rerolls = ctx.config(Rules).rerolls_per_run
        for perk, level in ctx.get(Records).perk_levels.items():
            for _ in range(level):
                apply_effect(ctx, perk.data.effect)
        self.dress_arena(ctx)
        survivor(ctx).get(SurfaceFx).dissolve_to(0, ctx.config(Rules).dissolve_seconds)
        if ctx.get(Choices).vigil:
            alert(ctx, ctx.text(Text.vigil_name), ctx.config(Rules).alert_seconds)

    def dress_arena(self, ctx):
        """Each decor layer is scattered over the arena and thinned by the seed's noise field."""
        for index, layer in enumerate(ctx.content(DecorDef)):
            decor = layer.data
            for spot in scatter(vec3(), decor.radius, decor.count, min_spacing=decor.min_spacing):
                if spot.length() < decor.clear_radius:
                    continue
                seed = ctx.seed + index * 101
                level = (ridged(spot, seed, decor.frequency, decor.octaves) if decor.ridged
                         else heat(spot, seed, decor.frequency, decor.octaves) * 2 - 1)
                keep = min(1.0, max(0.05, (level - decor.threshold) * decor.gain))
                if level < decor.threshold or random.random() > keep:
                    continue
                size = 1 + random.uniform(-decor.scale_variance, decor.scale_variance)
                ctx.world.spawn(decor.prefab, at=spot, rotation=vec3(0, random.uniform(0, 360), 0), scale=size)
