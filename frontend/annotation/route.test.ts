import { describe, expect, it } from 'vitest';
import { annotationHref, parseRoute } from './route';

describe('parseRoute', () => {
  it('defaults to the observatory for an empty or unknown hash', () => {
    expect(parseRoute('')).toEqual({ page: 'observatory' });
    expect(parseRoute('#')).toEqual({ page: 'observatory' });
    expect(parseRoute('#/nada')).toEqual({ page: 'observatory' });
    expect(parseRoute('#/observatorio')).toEqual({ page: 'observatory' });
  });
  it('recognises review and the annotation list', () => {
    expect(parseRoute('#/review')).toEqual({ page: 'review' });
    expect(parseRoute('#/anotacion')).toEqual({ page: 'annotation' });
    expect(parseRoute('#/anotacion/')).toEqual({ page: 'annotation' });
  });
  it('reads the session of an annotation workspace, decoded', () => {
    expect(parseRoute('#/anotacion/va-001-031026-1')).toEqual({ page: 'annotation', sessionId: 'va-001-031026-1' });
    expect(parseRoute('#/anotacion/a%20b')).toEqual({ page: 'annotation', sessionId: 'a b' });
  });
  it('ignores a malformed session id instead of throwing', () => {
    expect(parseRoute('#/anotacion/%E0%A4%A')).toEqual({ page: 'annotation' });
  });
  it('builds links that parse back to the same session', () => {
    for (const id of ['s1', 'a b', 'x/y']) expect(parseRoute(annotationHref(id))).toEqual({ page: 'annotation', sessionId: id });
    expect(annotationHref()).toBe('#/anotacion');
  });
});
