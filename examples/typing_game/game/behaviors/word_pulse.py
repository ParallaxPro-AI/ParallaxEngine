from parallax import Behavior, Color, Light, Shape, Vec3, behavior, on, param, state

from game.events import WordBreached, WordCleared


@behavior("word_pulse", requires=[Shape])
class WordPulse(Behavior):
    """Room dressing that reacts to the typing: it swells and brightens on every word
    cleared, or, as an `alarm`, on every word that breaches. There is no clock here;
    the room's pulse is the player's success and failure."""

    alarm: bool = param(False)
    punch: float = param(0.12, doc="Extra size at full pulse, as a fraction.")
    decay: float = param(5.0)
    idle_color: Color = param(Color.hex("#616f7c"))
    hit_color: Color = param(Color.hex("#a0e1ed"))
    energy: float = state(0.0)
    base_scale: Vec3 = state(Vec3.ONE)
    base_intensity: float = state(0.0)

    def start(self, ctx):
        self.base_scale = self.entity.transform.scale
        light = self.entity.try_get(Light)
        self.base_intensity = light.intensity if light else 0.0

    @on(WordCleared)
    def cleared(self, ctx, event):
        if not self.alarm:
            self.energy = 1.0

    @on(WordBreached)
    def breached(self, ctx, event):
        if self.alarm:
            self.energy = 1.0

    def update(self, ctx, dt):
        self.energy = max(0.0, self.energy - self.decay * dt)
        self.entity.transform.scale = self.base_scale * (1 + self.punch * self.energy)
        self.entity.get(Shape).color = self.idle_color.lerp(self.hit_color, self.energy)
        light = self.entity.try_get(Light)
        if light:
            light.intensity = self.base_intensity * (0.55 + 0.9 * self.energy)
