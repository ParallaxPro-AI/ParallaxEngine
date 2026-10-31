/** Angle helpers. The public API speaks degrees; trigonometry speaks radians. */

const DEG_PER_RAD = 180 / Math.PI;

export function deg(radians: number): number {
  return radians * DEG_PER_RAD;
}

export function rad(degrees: number): number {
  return degrees / DEG_PER_RAD;
}

/** Wrap to (-180, 180]. */
export function wrapAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}
