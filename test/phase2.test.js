import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, tables } from 'sdk/db';
import { apiCalls, clearApiCalls } from 'sdk/api';

import {
  upsertUser,
  getUser,
  setUserState,
  createCategory,
  createNote,
  getCategories,
  getNotesByCategory,
} from '../lib/db.js';
import { setCachedSuperAdminId } from '../lib/env.js';
import { handleMessage, handleCallbackQuery } from '../lib/router.js';
import router, { handleUpdate } from '../index.js';

test.beforeEach(() => {
  resetDatabase();
  clearApiCalls();
  setCachedSuperAdminId('9999');
});

test('Phase 2 - User Upsert Middleware: standard user', async () => {
  const user = await upsertUser({
    id: 101,
    first_name: 'Alice',
    last_name: 'Wonder',
    username: 'alicew',
  });

  assert.equal(user.id, 101);
  assert.equal(user.full_name, 'Alice Wonder');
  assert.equal(user.role, 'user');
  assert.equal(user.state, 'IDLE');
});

test('Phase 2 - User Upsert Middleware: super admin elevated to role admin', async () => {
  const admin = await upsertUser({
    id: 9999,
    first_name: 'Root',
  }, '9999');

  assert.equal(admin.id, 9999);
  assert.equal(admin.role, 'admin');
});

test('Phase 2 - User Upsert Middleware: /start force resets state and temp_data', async () => {
  // First set user in an active state
  await upsertUser({ id: 102, first_name: 'Bob' });
  await setUserState(102, 'WAIT_NOTE_FILE', { step: 2 });

  let user = await getUser(102);
  assert.equal(user.state, 'WAIT_NOTE_FILE');
  assert.ok(user.temp_data);

  // Now trigger onboarding with forceResetState
  await upsertUser({ id: 102, first_name: 'Bob' }, '', { forceResetState: true });
  user = await getUser(102);
  assert.equal(user.state, 'IDLE');
  assert.equal(user.temp_data, null);
});

test('Phase 2 - Onboarding /start Command renders Main Menu', async () => {
  const msg = {
    chat: { id: 101 },
    from: { id: 101, first_name: 'Alice' },
    text: '/start',
  };

  await handleMessage(msg);

  const sentMessage = apiCalls.find((c) => c.method === 'sendMessage');
  assert.ok(sentMessage);
  assert.equal(sentMessage.params.chat_id, 101);
  assert.ok(sentMessage.params.text.includes('Welcome to Broca Digital Library'));

  // Normal user should see "📚 Browse Library" button, but NOT "⚙️ Admin Panel"
  const buttons = sentMessage.params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'lib:cats'));
  assert.ok(!buttons.some((b) => b.callback_data === 'adm:menu'));
});

test('Phase 2 - Onboarding /start Command for Admin includes Admin Panel button', async () => {
  const msg = {
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'Boss' },
    text: '/start',
  };

  await handleMessage(msg);

  const sentMessage = apiCalls.find((c) => c.method === 'sendMessage');
  assert.ok(sentMessage);
  const buttons = sentMessage.params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'lib:cats'));
  assert.ok(buttons.some((b) => b.callback_data === 'adm:menu'));
});

test('Phase 2 - Categorized Browsing: displays categories with LIMIT 8 pagination', async () => {
  // Seed 10 categories
  for (let i = 1; i <= 10; i++) {
    await createCategory(`Category ${String(i).padStart(2, '0')}`);
  }

  // Click "lib:cats"
  const query = {
    id: 'q_cats_1',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: 'lib:cats',
  };

  await handleCallbackQuery(query);

  const edited = apiCalls.find((c) => c.method === 'editMessageText');
  assert.ok(edited);
  assert.ok(edited.params.text.includes('Page 1/2'));

  const buttons = edited.params.reply_markup.inline_keyboard.flat();
  // Page 1 should have 8 categories
  const catButtons = buttons.filter((b) => b.callback_data.startsWith('c:'));
  assert.equal(catButtons.length, 8);

  // Navigation row should have Next page button
  assert.ok(buttons.some((b) => b.callback_data === 'cp:2'));
  // And Back to Main Menu
  assert.ok(buttons.some((b) => b.callback_data === 'back:main'));
});

test('Phase 2 - Category Notes Browsing: lists notes inside category with dl: callbacks', async () => {
  const cat = await createCategory('Computer Science');
  await createNote({
    category_id: cat.id,
    title: 'Algorithms 101',
    file_id: 'doc_algo_pdf',
    file_type: 'document',
    file_name: 'algorithms.pdf',
    file_size: 2097152, // 2 MB
  });
  await createNote({
    category_id: cat.id,
    title: 'Data Structures Diagram',
    file_id: 'photo_ds_jpg',
    file_type: 'photo',
    file_size: 512000,
  });

  const query = {
    id: 'q_notes_1',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: `c:${cat.id}`,
  };

  await handleCallbackQuery(query);

  const edited = apiCalls.find((c) => c.method === 'editMessageText');
  assert.ok(edited);
  assert.ok(edited.params.text.includes('Computer Science'));

  const buttons = edited.params.reply_markup.inline_keyboard.flat();
  const dlButtons = buttons.filter((b) => b.callback_data.startsWith('dl:'));
  assert.equal(dlButtons.length, 2);
  assert.ok(buttons.some((b) => b.callback_data === 'back:cats'));
});

test('Phase 2 - One-Click File Download: document dispatch with HTML caption and size in MB', async () => {
  const cat = await createCategory('Physics');
  const note = await createNote({
    category_id: cat.id,
    title: 'Quantum Mechanics Notes',
    file_id: 'file_qm_123',
    file_type: 'document',
    file_name: 'quantum.pdf',
    file_size: 5242880, // 5.00 MB
  });

  const query = {
    id: 'q_dl_doc',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: `dl:${note.id}`,
  };

  await handleCallbackQuery(query);

  // 1. Immediately answers callback query
  const answered = apiCalls.find((c) => c.method === 'answerCallbackQuery');
  assert.ok(answered);
  assert.ok(answered.params.text.includes('Sending file'));

  // 2. Dispatches document with formatted HTML caption
  const sentDoc = apiCalls.find((c) => c.method === 'sendDocument');
  assert.ok(sentDoc);
  assert.equal(sentDoc.params.chat_id, 101);
  assert.equal(sentDoc.params.document, 'file_qm_123');
  assert.ok(sentDoc.params.caption.includes('Quantum Mechanics Notes'));
  assert.ok(sentDoc.params.caption.includes('5.00 MB'));
  assert.ok(sentDoc.params.caption.includes('Physics'));
});

test('Phase 2 - One-Click File Download: photo dispatch', async () => {
  const cat = await createCategory('Biology');
  const note = await createNote({
    category_id: cat.id,
    title: 'Cell Structure Diagram',
    file_id: 'photo_cell_999',
    file_type: 'photo',
    file_size: 1048576, // 1 MB
  });

  const query = {
    id: 'q_dl_photo',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: `dl:${note.id}`,
  };

  await handleCallbackQuery(query);

  const sentPhoto = apiCalls.find((c) => c.method === 'sendPhoto');
  assert.ok(sentPhoto);
  assert.equal(sentPhoto.params.photo, 'photo_cell_999');
  assert.ok(sentPhoto.params.caption.includes('Cell Structure Diagram'));
});

test('Phase 2 - One-Click File Download: video dispatch', async () => {
  const cat = await createCategory('Lectures');
  const note = await createNote({
    category_id: cat.id,
    title: 'Lecture 1 Video',
    file_id: 'video_lec_1',
    file_type: 'video',
    file_size: 52428800, // 50 MB
  });

  const query = {
    id: 'q_dl_vid',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: `dl:${note.id}`,
  };

  await handleCallbackQuery(query);

  const sentVid = apiCalls.find((c) => c.method === 'sendVideo');
  assert.ok(sentVid);
  assert.equal(sentVid.params.video, 'video_lec_1');
});

test('Phase 2 - One-Click File Download: audio dispatch', async () => {
  const cat = await createCategory('Podcasts');
  const note = await createNote({
    category_id: cat.id,
    title: 'Podcast Ep 1',
    file_id: 'audio_pod_1',
    file_type: 'audio',
    file_size: 15728640,
  });

  const query = {
    id: 'q_dl_audio',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: `dl:${note.id}`,
  };

  await handleCallbackQuery(query);

  const sentAudio = apiCalls.find((c) => c.method === 'sendAudio');
  assert.ok(sentAudio);
  assert.equal(sentAudio.params.audio, 'audio_pod_1');
});

test('Phase 2 - Global Escape Hatch: cancel button resets state and returns to Main Menu', async () => {
  await upsertUser({ id: 101, first_name: 'Alice' });
  await setUserState(101, 'WAIT_ADMIN_ID');

  const query = {
    id: 'q_cancel',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 50 },
    data: 'cancel',
  };

  await handleCallbackQuery(query);

  const user = await getUser(101);
  assert.equal(user.state, 'IDLE');

  const edited = apiCalls.find((c) => c.method === 'editMessageText');
  assert.ok(edited);
  assert.ok(edited.params.text.includes('Welcome to Broca Digital Library'));
});

test('Phase 2 - Master Router index.js handles update envelope and payload', async () => {
  // Test with Telegram Update envelope
  const update = {
    update_id: 8888,
    message: {
      chat: { id: 202 },
      from: { id: 202, first_name: 'Charlie' },
      text: '/start',
    },
  };

  await router(update);

  const sentMsg = apiCalls.find((c) => c.method === 'sendMessage');
  assert.ok(sentMsg);
  assert.equal(sentMsg.params.chat_id, 202);
});
