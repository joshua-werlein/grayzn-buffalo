import assert from 'node:assert/strict';
import test from 'node:test';
import { imageFormat, imageKey, imageSourceVersion, shouldRefreshImage } from './worker.js';

test('maps supported Facebook image content types to matching extensions', () => {
  assert.deepEqual(imageFormat('image/jpeg'), { extension: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(imageFormat('image/png; charset=binary'), { extension: 'png', contentType: 'image/png' });
  assert.deepEqual(imageFormat('image/webp'), { extension: 'webp', contentType: 'image/webp' });
  assert.deepEqual(imageFormat('image/gif'), { extension: 'gif', contentType: 'image/gif' });
});

test('uses a conservative fallback for unknown or missing content types', () => {
  assert.deepEqual(imageFormat('image/avif'), { extension: 'bin', contentType: 'image/avif' });
  assert.deepEqual(imageFormat(null), { extension: 'bin', contentType: 'application/octet-stream' });
});

test('does not refresh an existing image when its source version is unchanged', () => {
  const post = {
    id: '123',
    full_picture: 'https://cdn.example.com/photos/123.jpg?temporary-token=second',
    updated_time: '2026-08-04T18:00:00+0000',
  };
  const previous = {
    imageKey: 'facebook/123-abc.jpg',
    imageSourceVersion: imageSourceVersion(post),
  };

  assert.equal(shouldRefreshImage(post, previous), false);
});

test('refreshes an existing image when Graph reports a changed source version', () => {
  const previous = {
    imageKey: 'facebook/123-abc.jpg',
    imageSourceVersion: 'updated:2026-08-04T18:00:00+0000',
  };
  const changedPost = {
    id: '123',
    full_picture: 'https://cdn.example.com/photos/123-replaced.png',
    updated_time: '2026-08-04T19:00:00+0000',
  };

  assert.equal(shouldRefreshImage(changedPost, previous), true);
  assert.equal(imageKey(changedPost.id, 'abcdef', 'png'), 'facebook/123-abcdef.png');
});

test('uses a normalized image URL only when updated_time is unavailable', () => {
  const base = { id: '123', full_picture: 'https://cdn.example.com/photos/123.jpg?first-token' };
  const sameImageDifferentQuery = { ...base, full_picture: 'https://cdn.example.com/photos/123.jpg?second-token' };
  const previous = { imageKey: 'facebook/123-abc.jpg', imageSourceVersion: imageSourceVersion(base) };

  assert.equal(imageSourceVersion(base), imageSourceVersion(sameImageDifferentQuery));
  assert.equal(shouldRefreshImage(sameImageDifferentQuery, previous), false);
});
