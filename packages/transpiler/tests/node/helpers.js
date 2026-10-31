// Test-only stand-in for a kernel wait: `await wait(x)` yields x to the driver.
export function wait(value) {
  return value;
}
