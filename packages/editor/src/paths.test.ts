import { afterEach, describe, expect, it } from 'vitest';
import { serverUrl, setServerBase } from './paths.js';

describe('the server base', () => {
  afterEach(() => setServerBase('/'));

  it('serves from the root by default, as parallax edit does', () => {
    expect(serverUrl('/__parallax__/save')).toBe('/__parallax__/save');
    expect(serverUrl('build/v3/')).toBe('/build/v3/');
  });

  it('puts every path under a host page\'s base, with or without its trailing slash', () => {
    setServerBase('/parallax/abc/edit');
    expect(serverUrl('/__parallax__/events')).toBe('/parallax/abc/edit/__parallax__/events');
    setServerBase('/parallax/abc/edit/');
    expect(serverUrl('project-files.json')).toBe('/parallax/abc/edit/project-files.json');
  });
});
