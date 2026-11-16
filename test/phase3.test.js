import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, tables } from 'sdk/db';
import { apiCalls, clearApiCalls } from 'sdk/api';

import {
  upsertUser,
  getUser,
  createCategory,
  getCategoryById,
  createNote,
  getNoteById,
} from '../lib/db.js';
import { setCachedSuperAdminId } from '../lib/env.js';
import { handleMessage, handleCallbackQuery } from '../lib/router.js';

test.beforeEach(() => {
  resetDatabase();
  clearApiCalls();
  setCachedSuperAdminId('9999');
});

test('Phase 3 - Admin Dashboard: Access granted for admin, denied for regular user', async () => {
  // 1. Regular user denied
  const userQuery = {
    id: 'q_adm_denied',
    from: { id: 101, first_name: 'Alice' },
    message: { chat: { id: 101 }, message_id: 10 },
    data: 'adm:menu',
  };
  await handleCallbackQuery(userQuery);

  const deniedNotice = apiCalls.find((c) => c.method === 'answerCallbackQuery');
  assert.ok(deniedNotice);
  assert.ok(deniedNotice.params.text.includes('Access denied'));

  clearApiCalls();

  // 2. Admin access granted
  const adminQuery = {
    id: 'q_adm_granted',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: 'adm:menu',
  };
  await handleCallbackQuery(adminQuery);

  const edited = apiCalls.find((c) => c.method === 'editMessageText');
  assert.ok(edited);
  assert.ok(edited.params.text.includes('Admin Dashboard'));
  const buttons = edited.params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'adm:stats'));
  assert.ok(buttons.some((b) => b.callback_data === 'adm:add_note'));
  assert.ok(buttons.some((b) => b.callback_data === 'adm:cats'));
  assert.ok(buttons.some((b) => b.callback_data === 'adm:add_admin'));
});

test('Phase 3 - Analytics: Displays registered user, category, and note counts', async () => {
  // Seed database
  await upsertUser({ id: 101, first_name: 'User 1' });
  await upsertUser({ id: 102, first_name: 'User 2' });
  const cat = await createCategory('Math');
  await createNote({
    category_id: cat.id,
    title: 'Calculus Notes',
    file_id: 'f_calc',
    file_type: 'document',
    file_size: 1024,
  });

  const query = {
    id: 'q_stats',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: 'adm:stats',
  };
  await handleCallbackQuery(query);

  const edited = apiCalls.find((c) => c.method === 'editMessageText');
  assert.ok(edited);
  assert.ok(edited.params.text.includes('Registered Users:'));
  assert.ok(edited.params.text.includes('Categories:'));
  assert.ok(edited.params.text.includes('Stored Notes & Files:'));
});

test('Phase 3 - Promote New Admin: numeric User ID flow', async () => {
  // Step 1: Admin clicks "👤 Add New Admin"
  const query = {
    id: 'q_add_adm',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: 'adm:add_admin',
  };
  await handleCallbackQuery(query);

  const admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_ADMIN_ID');

  // Step 2: Admin sends numeric user ID of candidate
  await upsertUser({ id: 555, first_name: 'Candidate' });
  const idMsg = {
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    text: '555',
  };
  await handleMessage(idMsg);

  const promoted = await getUser(555);
  assert.equal(promoted.role, 'admin');

  const adminAfter = await getUser(9999);
  assert.equal(adminAfter.state, 'IDLE');

  const confirmMsg = apiCalls.find((c) => c.method === 'sendMessage' && c.params.text.includes('Admin Successfully Promoted'));
  assert.ok(confirmMsg);
});

test('Phase 3 - Promote New Admin: forwarded message flow', async () => {
  // Admin clicks add admin
  await handleCallbackQuery({
    id: 'q_add_adm_fwd',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: 'adm:add_admin',
  });

  // Admin forwards message from user 777
  await upsertUser({ id: 777, first_name: 'ForwardUser' });
  const fwdMsg = {
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    text: 'A forwarded message',
    forward_from: { id: 777, first_name: 'ForwardUser' },
  };
  await handleMessage(fwdMsg);

  const promoted = await getUser(777);
  assert.equal(promoted.role, 'admin');
});

test('Phase 3 - 3-Step Add Note FSM: Existing Category Flow', async () => {
  const cat = await createCategory('Engineering');

  // Step 1: Admin clicks "➕ Upload Note / File"
  await handleCallbackQuery({
    id: 'q_add_note',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: 'adm:add_note',
  });

  let admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_NOTE_CAT');

  // Step 1 selection: Admin picks category
  await handleCallbackQuery({
    id: 'q_sel_cat',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: `adm_sel_cat:${cat.id}`,
  });

  admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_NOTE_TITLE');

  // Step 2: Admin enters note title
  await handleMessage({
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    text: 'Thermodynamics Chapter 1',
  });

  admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_NOTE_FILE');

  // Step 3: Admin uploads file
  await handleMessage({
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    document: {
      file_id: 'doc_thermo_pdf',
      file_name: 'thermo_ch1.pdf',
      file_size: 4194304, // 4 MB
    },
  });

  admin = await getUser(9999);
  assert.equal(admin.state, 'IDLE');

  // Verify note exists in database
  const notes = Array.from(tables.notes.values());
  const createdNote = notes.find((n) => n.title === 'Thermodynamics Chapter 1');
  assert.ok(createdNote);
  assert.equal(createdNote.file_id, 'doc_thermo_pdf');
  assert.equal(createdNote.file_type, 'document');
  assert.equal(createdNote.file_size, 4194304);
  assert.equal(createdNote.category_id, cat.id);
});

test('Phase 3 - 3-Step Add Note FSM: New Category Branch', async () => {
  // Step 1: Admin clicks Add Note -> New Category for note
  await handleCallbackQuery({
    id: 'q_new_cat_note',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: 'adm:new_cat_for_note',
  });

  let admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_NEW_CAT_NAME');

  // Send new category name
  await handleMessage({
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    text: 'Artificial Intelligence',
  });

  admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_NOTE_TITLE');

  // Send title
  await handleMessage({
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    text: 'Neural Networks Overview',
  });

  admin = await getUser(9999);
  assert.equal(admin.state, 'WAIT_NOTE_FILE');

  // Send video file
  await handleMessage({
    chat: { id: 9999 },
    from: { id: 9999, first_name: 'SuperAdmin' },
    video: {
      file_id: 'vid_nn_mp4',
      file_name: 'nn_overview.mp4',
      file_size: 15728640,
    },
  });

  admin = await getUser(9999);
  assert.equal(admin.state, 'IDLE');

  const notes = Array.from(tables.notes.values());
  const created = notes.find((n) => n.title === 'Neural Networks Overview');
  assert.ok(created);
  assert.equal(created.file_type, 'video');
});

test('Phase 3 - Delete Content: Category Deletion with cascade', async () => {
  const cat = await createCategory('To Be Deleted');
  await createNote({
    category_id: cat.id,
    title: 'Note In Cat',
    file_id: 'f_test',
    file_type: 'document',
  });

  // Step 1: Admin triggers delete confirmation
  await handleCallbackQuery({
    id: 'q_del_c',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: `del_c:${cat.id}`,
  });

  const confirmMsg = apiCalls.find((c) => c.method === 'editMessageText' && c.params.text.includes('Delete Category'));
  assert.ok(confirmMsg);

  // Step 2: Confirm deletion
  await handleCallbackQuery({
    id: 'q_cnf_del_c',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: `cnf_del_c:${cat.id}`,
  });

  // Category and notes should be gone from DB
  const fetchedCat = await getCategoryById(cat.id);
  assert.equal(fetchedCat, null);
  const remainingNotes = Array.from(tables.notes.values()).filter((n) => n.category_id === cat.id);
  assert.equal(remainingNotes.length, 0);
});

test('Phase 3 - Delete Content: Individual Note Deletion with confirmation', async () => {
  const cat = await createCategory('Literature');
  const note = await createNote({
    category_id: cat.id,
    title: 'Sample Poem',
    file_id: 'f_poem',
    file_type: 'document',
  });

  // Trigger delete note confirmation
  await handleCallbackQuery({
    id: 'q_del_n',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: `del_n:${note.id}`,
  });

  const prompt = apiCalls.find((c) => c.method === 'editMessageText' && c.params.text.includes('Delete File'));
  assert.ok(prompt);

  // Confirm delete note
  await handleCallbackQuery({
    id: 'q_cnf_del_n',
    from: { id: 9999, first_name: 'SuperAdmin' },
    message: { chat: { id: 9999 }, message_id: 10 },
    data: `cnf_del_n:${note.id}`,
  });

  const fetchedNote = await getNoteById(note.id);
  assert.equal(fetchedNote, null);
});
