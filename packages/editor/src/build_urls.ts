/**
 * The build URL each runtime rebuild loads. The page caches a build's modules by URL, and a
 * game's modules set up its plugins once, when they first load: a runtime rebuilt from modules
 * an earlier runtime used fails (PP9153, "This physics3d plugin is already installed in another
 * kernel"). So a URL is never loaded twice: a rebuild that would reuse one (a model added
 * during Play, taken after Stop, on the build that was already running) gets the same build
 * under a number no runtime used. The editor's server serves its current build under any
 * `/build/v<N>/` prefix.
 */
export class BuildUrls {
  readonly #used = new Set<string>();
  readonly #numbered: (n: number) => string;
  #fresh = Date.now();

  /** `numbered(n)`: the editor's own build under the prefix `v<n>`. */
  constructor(numbered: (n: number) => string) {
    this.#numbered = numbered;
  }

  /** A runtime loaded this URL (the page's first boot). */
  loaded(url: string): void {
    this.#used.add(url);
  }

  /** The URL to load for `preferred`: itself the first time, then the editor's build under a fresh number. */
  next(preferred: string): string {
    const url = this.#used.has(preferred) ? this.#numbered(++this.#fresh) : preferred;
    this.#used.add(url);
    return url;
  }
}
