"""The heat field: where the horde comes from and where the cairns pile up.

It is a pure function of (seed, x, z), so a seed always produces the same arena and the
same hot sectors, which a player can learn.
"""

from parallax import Vec3, noise2d


def heat(point: Vec3, seed: int, frequency: float, octaves: int) -> float:
    """Fractal noise in 0..1 on the ground plane: octaves of `noise2d`, each finer and fainter."""
    total, amplitude, weight = 0.0, 1.0, 0.0
    for octave in range(octaves):
        total += noise2d(point.x * frequency, point.z * frequency, seed=seed + octave) * amplitude
        weight += amplitude
        amplitude *= 0.5
        frequency *= 2
    return (total / weight + 1) / 2


def ridged(point: Vec3, seed: int, frequency: float, octaves: int) -> float:
    """Ridged multifractal in about -1..1: sharp veins where the noise crosses zero, each
    octave gated by the one before (the template's `noise2D` "ridged" kind)."""
    total, amplitude, weight, previous = 0.0, 1.0, 0.0, 1.0
    for octave in range(octaves):
        value = (1 - abs(noise2d(point.x * frequency, point.z * frequency, seed=seed + octave))) ** 2
        value *= min(1.0, max(0.0, previous))
        previous = value
        total += value * amplitude
        weight += amplitude
        amplitude *= 0.5
        frequency *= 2
    return total / weight * 2 - 1
