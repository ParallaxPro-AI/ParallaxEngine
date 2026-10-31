"""Per-instance variety (library piece `model_variety`).

Sixteen copies of one pedestrian prefab should be sixteen people. At spawn this picks, from
the seeded `random` (so a replay, a playtest and every network peer see the same crowd):

    options   the options to vary — every choice     ["skin", "outfit"]  ([] = every option)
              the model declares is a candidate
    choices   option → only these choices            {"skin": ["light", "tan"]}
    colors    material → a palette                   {"jacket": ["#2b4a8b", "#7a2b2b"]}
    height    ± fraction of uniform scale            0.05 → 0.95× … 1.05×
    gait      ± fraction of Animator speed           0.1  → strides out of step

Everything lands in the Model's own fields (`options`, `colors`) and the transform, so the
look saves and replicates with the entity; nothing runs after the first frame."""

import random

from parallax import Animator, Behavior, Color, Model, behavior, param


@behavior("model_variety", requires=[Model])
class ModelVariety(Behavior):
    """Dresses this copy from the choice lists."""

    options: list[str] = param([], doc="Model options to vary from all their choices; [] = every option it declares.")
    choices: dict[str, list[str]] = param({}, doc="Model option → the only choices to pick from.")
    colors: dict[str, list[Color]] = param({}, doc="Material → palette to pick from.")
    height: float = param(0.0, min=0, max=0.5, doc="± fraction of uniform scale.")
    gait: float = param(0.0, min=0, max=0.5, doc="± fraction of Animator playback speed.")

    def start(self, ctx):
        model = self.entity.get(Model)
        varied = set(self.options or model.option_names()) | set(self.choices)
        for option in sorted(varied):
            picks = self.choices.get(option) or model.choices(option)
            model.set_option(option, random.choice(picks))
        for material in sorted(self.colors):
            palette = self.colors[material]
            if palette:
                model.set_color(material, random.choice(palette))
        if self.height > 0:
            self.entity.transform.scale = self.entity.transform.scale * (1 + random.uniform(-self.height, self.height))
        animator = self.entity.try_get(Animator)
        if animator is not None and self.gait > 0:
            animator.speed = animator.speed * (1 + random.uniform(-self.gait, self.gait))
