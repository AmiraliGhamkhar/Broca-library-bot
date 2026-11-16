import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileMeta,
  escapeHtml,
  escapeMarkdownV2,
  formatFileSize,
  truncateText,
  buildPaginationKeyboard,
  buildCategoriesKeyboard,
  buildNotesKeyboard,
  isAdmin,
  parseCallbackData,
} from '../lib/helpers.js';

test('extractFileMeta - document', () => {
  const msg = {
    document: {
      file_id: 'doc_123',
      file_name: 'Lecture_01.pdf',
      file_size: 1048576,
    },
  };
  const result = extractFileMeta(msg);
  assert.deepEqual(result, {
    file_id: 'doc_123',
    file_type: 'document',
    file_name: 'Lecture_01.pdf',
    file_size: 1048576,
  });
});

test('extractFileMeta - photo (takes largest)', () => {
  const msg = {
    photo: [
      { file_id: 'photo_small', file_size: 100 },
      { file_id: 'photo_large', file_size: 5000, file_unique_id: 'uniq_p' },
    ],
  };
  const result = extractFileMeta(msg);
  assert.deepEqual(result, {
    file_id: 'photo_large',
    file_type: 'photo',
    file_name: 'photo_uniq_p.jpg',
    file_size: 5000,
  });
});

test('extractFileMeta - video', () => {
  const msg = {
    video: {
      file_id: 'vid_999',
      file_name: 'intro.mp4',
      file_size: 20971520,
    },
  };
  const result = extractFileMeta(msg);
  assert.deepEqual(result, {
    file_id: 'vid_999',
    file_type: 'video',
    file_name: 'intro.mp4',
    file_size: 20971520,
  });
});

test('extractFileMeta - audio', () => {
  const msg = {
    audio: {
      file_id: 'aud_456',
      title: 'Pod Episode 1',
      performer: 'Broca',
      file_size: 15728640,
    },
  };
  const result = extractFileMeta(msg);
  assert.deepEqual(result, {
    file_id: 'aud_456',
    file_type: 'audio',
    file_name: 'Broca - Pod Episode 1.mp3',
    file_size: 15728640,
  });
});

test('extractFileMeta - null on invalid message or text message', () => {
  assert.equal(extractFileMeta(null), null);
  assert.equal(extractFileMeta({ text: 'Hello' }), null);
});

test('escapeHtml - escapes special HTML entities', () => {
  const raw = '<script>alert("test & win")</script>';
  const escaped = escapeHtml(raw);
  assert.equal(escaped, '&lt;script&gt;alert(&quot;test &amp; win&quot;)&lt;/script&gt;');
});

test('escapeHtml - handles null or undefined', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeMarkdownV2 - escapes reserved characters', () => {
  const raw = 'File_name.pdf [v1.0]!';
  const escaped = escapeMarkdownV2(raw);
  assert.equal(escaped, 'File\\_name\\.pdf \\[v1\\.0\\]\\!');
});

test('formatFileSize - B, KB, MB formatting', () => {
  assert.equal(formatFileSize(500), '500 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(1024 * 1024), '1.00 MB');
  assert.equal(formatFileSize(1024 * 1024 * 2.5), '2.50 MB');
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(-10), '0 B');
});

test('truncateText - truncates long titles', () => {
  assert.equal(truncateText('Short', 10), 'Short');
  assert.equal(truncateText('This is a very long title for button', 15), 'This is a very…');
});

test('buildPaginationKeyboard - pagination logic', () => {
  const items = [
    { id: 1, name: 'Item 1' },
    { id: 2, name: 'Item 2' },
  ];
  const keyboard = buildPaginationKeyboard({
    items,
    currentPage: 2,
    totalPages: 3,
    getItemButton: (item) => ({ text: item.name, callback_data: `item:${item.id}` }),
    getPageCallback: (page) => `page:${page}`,
    itemsPerRow: 2,
  });

  // First row: 2 items
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0].length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].text, 'Item 1');
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'item:1');

  // Second row: Nav buttons (Prev, Page 2/3, Next)
  const navRow = keyboard.inline_keyboard[1];
  assert.equal(navRow.length, 3);
  assert.equal(navRow[0].text, '◀️ Prev');
  assert.equal(navRow[0].callback_data, 'page:1');
  assert.equal(navRow[1].text, '📄 2/3');
  assert.equal(navRow[1].callback_data, 'noop');
  assert.equal(navRow[2].text, 'Next ▶️');
  assert.equal(navRow[2].callback_data, 'page:3');
});

test('buildCategoriesKeyboard - compact callbacks and limits', () => {
  const cats = [
    { id: 10, title: 'Mathematics' },
    { id: 20, title: 'Computer Science' },
  ];
  const kb = buildCategoriesKeyboard({
    categories: cats,
    currentPage: 1,
    totalPages: 1,
    isAdmin: true,
  });

  // All callback_data must be <= 64 bytes
  for (const row of kb.inline_keyboard) {
    for (const btn of row) {
      assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `Button exceeds 64 bytes: ${btn.callback_data}`);
    }
  }

  assert.equal(kb.inline_keyboard[0][0].callback_data, 'c:10');
  assert.equal(kb.inline_keyboard[0][1].callback_data, 'c:20');
});

test('isAdmin - checks role and super admin ID', () => {
  assert.equal(isAdmin({ id: 123, role: 'admin' }, '999'), true);
  assert.equal(isAdmin({ id: 999, role: 'user' }, '999'), true);
  assert.equal(isAdmin({ id: 123, role: 'user' }, '999'), false);
  assert.equal(isAdmin(null, '999'), false);
});

test('parseCallbackData - parses action and args', () => {
  assert.deepEqual(parseCallbackData('dl:45'), {
    action: 'dl',
    args: ['45'],
    raw: 'dl:45',
  });
  assert.deepEqual(parseCallbackData('np:12:3'), {
    action: 'np',
    args: ['12', '3'],
    raw: 'np:12:3',
  });
  assert.deepEqual(parseCallbackData('cancel'), {
    action: 'cancel',
    args: [],
    raw: 'cancel',
  });
});
