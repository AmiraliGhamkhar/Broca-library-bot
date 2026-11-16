/**
 * Broca Digital Library Bot - Core Router & Business Logic
 * Dispatches messages and callback queries to appropriate handlers.
 * Enforces user upsert middleware, role checks, and DB-backed FSM transitions.
 */

import { api } from 'sdk';
import { getSuperAdminId } from './env.js';
import {
  parseCallbackData,
  isAdmin,
  escapeHtml,
  formatFileSize,
  extractFileMeta,
  truncateText,
} from './helpers.js';
import {
  upsertUser,
  setUserState,
  setUserRole,
  getUser,
  getCategories,
  getCategoryById,
  createCategory,
  deleteCategory,
  getNotesByCategory,
  getNoteById,
  createNote,
  deleteNote,
  getAnalytics,
} from './db.js';
import {
  answerCallback,
  safeEditMessage,
  sendMainMenu,
  editMainMenu,
  editCategoriesView,
  editNotesView,
  dispatchNoteFile,
} from './telegram.js';

/**
 * Handle incoming Message updates (commands, text, uploaded files).
 *
 * @param {object} message - Telegram Message object (update.message)
 * @param {object} [ctx] - Serverless execution context
 */
export async function handleMessage(message, ctx = {}) {
  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const fromUser = message.from || { id: chatId, first_name: 'User' };
  const text = message.text ? message.text.trim() : '';
  const superAdminId = await getSuperAdminId();

  // Middleware: Upsert user and force reset FSM state if /start command is issued
  const isStart = text.startsWith('/start');
  const user = await upsertUser(fromUser, superAdminId, { forceResetState: isStart });

  // 1. /start Command - Onboarding & Main Menu
  if (isStart) {
    await sendMainMenu(chatId, user, superAdminId);
    return;
  }

  // 2. Global Escape Hatch: /cancel or 'cancel' text
  if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
    await setUserState(user.id, 'IDLE', null);
    await api.sendMessage({
      chat_id: chatId,
      text: '❌ <i>Operation cancelled. State reset to IDLE.</i>',
      parse_mode: 'HTML',
    });
    await sendMainMenu(chatId, user, superAdminId);
    return;
  }

  // 3. /library or /categories shortcut
  if (text.startsWith('/library') || text.startsWith('/categories')) {
    const { categories, totalPages, currentPage } = await getCategories(1, 8);
    const reply_markup = (await import('./helpers.js')).buildCategoriesKeyboard({
      categories,
      currentPage,
      totalPages,
      isAdmin: isAdmin(user, superAdminId),
      adminMode: false,
    });
    await api.sendMessage({
      chat_id: chatId,
      text: `📚 <b>Library Categories</b> (Page ${currentPage}/${totalPages})\n\nSelect a category below to explore its available files:`,
      reply_markup,
      parse_mode: 'HTML',
    });
    return;
  }

  // 4. Handle DB-Backed Finite State Machine (FSM)
  if (user.state && user.state !== 'IDLE') {
    // Parse intermediate temporary data
    let tempData = {};
    if (user.temp_data) {
      try {
        tempData = typeof user.temp_data === 'string' ? JSON.parse(user.temp_data) : user.temp_data;
      } catch {
        tempData = {};
      }
    }

    // Role gate for admin states
    if (!isAdmin(user, superAdminId)) {
      await setUserState(user.id, 'IDLE', null);
      await api.sendMessage({
        chat_id: chatId,
        text: '⛔️ <i>You do not have permission to execute this administrative action.</i>',
        parse_mode: 'HTML',
      });
      await sendMainMenu(chatId, user, superAdminId);
      return;
    }

    // State A: WAIT_ADMIN_ID (Add new admin)
    if (user.state === 'WAIT_ADMIN_ID') {
      let targetUserId = null;

      // Check forwarded message first (forward_origin or forward_from)
      if (message.forward_origin?.sender_user?.id) {
        targetUserId = Number(message.forward_origin.sender_user.id);
      } else if (message.forward_from?.id) {
        targetUserId = Number(message.forward_from.id);
      } else if (/^\d+$/.test(text)) {
        targetUserId = Number(text);
      }

      if (!targetUserId) {
        await api.sendMessage({
          chat_id: chatId,
          text: `⚠️ <b>Invalid Telegram User ID.</b>\n\nPlease provide a numeric Telegram ID (e.g. <code>123456789</code>) or forward a message from the target user:`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      // Elevate target user to admin
      await setUserRole(targetUserId, 'admin');
      await setUserState(user.id, 'IDLE', null);

      await api.sendMessage({
        chat_id: chatId,
        text: `✅ <b>Admin Successfully Promoted!</b>\n\nUser ID <code>${targetUserId}</code> has been promoted to <b>Admin</b> with full privileges.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ Admin Dashboard', callback_data: 'adm:menu' }],
            [{ text: '🔙 Main Menu', callback_data: 'back:main' }],
          ],
        },
        parse_mode: 'HTML',
      });
      return;
    }

    // State B: WAIT_NEW_CAT_NAME (Creating new category name)
    if (user.state === 'WAIT_NEW_CAT_NAME') {
      const catTitle = text.trim();
      if (!catTitle) {
        await api.sendMessage({
          chat_id: chatId,
          text: '⚠️ Category name cannot be empty. Please enter a valid name:',
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
        });
        return;
      }

      const newCategory = await createCategory(catTitle);

      // If user was creating category as part of Add Note wizard, transition to WAIT_NOTE_TITLE
      if (tempData.flow === 'add_note') {
        const nextTempData = {
          ...tempData,
          category_id: newCategory.id,
          category_title: newCategory.title,
        };
        await setUserState(user.id, 'WAIT_NOTE_TITLE', nextTempData);

        await api.sendMessage({
          chat_id: chatId,
          text: `✅ Category <b>${escapeHtml(newCategory.title)}</b> created!\n\n` +
            `➕ <b>Step 2 of 3: Note Title</b>\n\n` +
            `Please send the display title for this note/file:`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      // Otherwise category was created from Category Management
      await setUserState(user.id, 'IDLE', null);
      await api.sendMessage({
        chat_id: chatId,
        text: `✅ Category <b>${escapeHtml(newCategory.title)}</b> has been created successfully!`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📁 Manage Categories', callback_data: 'adm:cats' }],
            [{ text: '⚙️ Admin Dashboard', callback_data: 'adm:menu' }],
          ],
        },
        parse_mode: 'HTML',
      });
      return;
    }

    // State C: WAIT_NOTE_TITLE (Step 2 of Add Note)
    if (user.state === 'WAIT_NOTE_TITLE') {
      const noteTitle = text.trim();
      if (!noteTitle) {
        await api.sendMessage({
          chat_id: chatId,
          text: '⚠️ Note title cannot be empty. Please enter a display title:',
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
        });
        return;
      }

      const nextTempData = {
        ...tempData,
        title: noteTitle,
      };
      await setUserState(user.id, 'WAIT_NOTE_FILE', nextTempData);

      await api.sendMessage({
        chat_id: chatId,
        text: `➕ <b>Step 3 of 3: Upload File</b>\n\n` +
          `📁 <b>Category:</b> ${escapeHtml(tempData.category_title || 'General')}\n` +
          `📖 <b>Title:</b> ${escapeHtml(noteTitle)}\n\n` +
          `Now send any file to publish (PDF, Word, Excel, ZIP, photo, video, or audio):`,
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
        },
        parse_mode: 'HTML',
      });
      return;
    }

    // State D: WAIT_NOTE_FILE (Step 3 of Add Note)
    if (user.state === 'WAIT_NOTE_FILE') {
      const fileMeta = extractFileMeta(message);

      if (!fileMeta) {
        await api.sendMessage({
          chat_id: chatId,
          text: `⚠️ <b>No file detected.</b>\n\nPlease upload a document, photo, video, or audio file, or tap Cancel:`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      // Save note to database
      const created = await createNote({
        category_id: tempData.category_id,
        title: tempData.title,
        file_id: fileMeta.file_id,
        file_type: fileMeta.file_type,
        file_name: fileMeta.file_name,
        file_size: fileMeta.file_size,
      });

      // Reset user state to IDLE
      await setUserState(user.id, 'IDLE', null);

      await api.sendMessage({
        chat_id: chatId,
        text: `🎉 <b>File Uploaded & Published Successfully!</b>\n\n` +
          `📖 <b>Title:</b> ${escapeHtml(created.title)}\n` +
          `📁 <b>Category:</b> ${escapeHtml(tempData.category_title || 'Library')}\n` +
          `📦 <b>Size:</b> <code>${formatFileSize(created.file_size)}</code>\n` +
          `🏷 <b>Format:</b> <code>${created.file_type}</code>\n` +
          `📎 <b>Filename:</b> <code>${escapeHtml(created.file_name || 'N/A')}</code>`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📁 View in Library', callback_data: `c:${tempData.category_id}` }],
            [{ text: '➕ Upload Another', callback_data: 'adm:add_note' }],
            [{ text: '⚙️ Admin Dashboard', callback_data: 'adm:menu' }],
          ],
        },
        parse_mode: 'HTML',
      });
      return;
    }
  }

  // 5. Default fallback for plain messages
  await api.sendMessage({
    chat_id: chatId,
    text: `👋 Hi <b>${escapeHtml(user.full_name)}</b>!\n\nUse the buttons below to explore the digital library:`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '📚 Browse Library', callback_data: 'lib:cats' }],
        ...(isAdmin(user, superAdminId)
          ? [[{ text: '⚙️ Admin Panel', callback_data: 'adm:menu' }]]
          : []),
      ],
    },
    parse_mode: 'HTML',
  });
}

/**
 * Handle incoming CallbackQuery updates (inline button taps).
 *
 * @param {object} query - Telegram CallbackQuery object (update.callback_query)
 * @param {object} [ctx] - Serverless execution context
 */
export async function handleCallbackQuery(query, ctx = {}) {
  if (!query) return;

  const queryId = query.id;
  const message = query.message;
  const fromUser = query.from;
  const rawData = query.data || '';
  const superAdminId = await getSuperAdminId();

  // Always answer noop immediately to stop spinner
  if (rawData === 'noop') {
    await answerCallback(queryId);
    return;
  }

  if (!message || !message.chat) {
    await answerCallback(queryId);
    return;
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;

  // Middleware: Upsert user on callback query
  const user = await upsertUser(fromUser, superAdminId);
  const { action, args } = parseCallbackData(rawData);

  switch (action) {
    // ---------------------------------------------------------
    // Global Escape Hatch
    // ---------------------------------------------------------
    case 'cancel': {
      await setUserState(user.id, 'IDLE', null);
      await answerCallback(queryId, 'Operation cancelled.');
      await editMainMenu(chatId, messageId, user, superAdminId);
      return;
    }

    // ---------------------------------------------------------
    // Navigation Back Handlers
    // ---------------------------------------------------------
    case 'back': {
      const target = args[0] || 'main';
      await answerCallback(queryId);
      if (target === 'main') {
        await editMainMenu(chatId, messageId, user, superAdminId);
      } else if (target === 'cats') {
        await editCategoriesView({ chatId, messageId, page: 1, user, superAdminId });
      }
      return;
    }

    // ---------------------------------------------------------
    // User Library Browsing
    // ---------------------------------------------------------
    case 'lib': {
      const sub = args[0];
      if (sub === 'cats') {
        await answerCallback(queryId);
        await editCategoriesView({ chatId, messageId, page: 1, user, superAdminId });
      }
      return;
    }

    // Category Pagination: cb: "cp:<page>"
    case 'cp': {
      const page = Number(args[0]) || 1;
      await answerCallback(queryId);
      await editCategoriesView({ chatId, messageId, page, user, superAdminId });
      return;
    }

    // View Notes inside Category: cb: "c:<category_id>"
    case 'c': {
      const categoryId = Number(args[0]);
      if (!categoryId) {
        await answerCallback(queryId, 'Invalid category.', true);
        return;
      }
      await answerCallback(queryId);
      await editNotesView({ chatId, messageId, categoryId, page: 1 });
      return;
    }

    // Notes Pagination inside Category: cb: "np:<category_id>:<page>"
    case 'np': {
      const categoryId = Number(args[0]);
      const page = Number(args[1]) || 1;
      await answerCallback(queryId);
      await editNotesView({ chatId, messageId, categoryId, page });
      return;
    }

    // ---------------------------------------------------------
    // One-Click File Download: cb: "dl:<note_id>"
    // ---------------------------------------------------------
    case 'dl': {
      const noteId = Number(args[0]);
      if (!noteId) {
        await answerCallback(queryId, 'Invalid file identifier.', true);
        return;
      }

      await answerCallback(queryId, 'Sending file to your chat... ⏳');

      const note = await getNoteById(noteId);
      if (!note) {
        await api.sendMessage({
          chat_id: chatId,
          text: '❌ <b>File not found.</b> It may have been removed by an administrator.',
          parse_mode: 'HTML',
        });
        return;
      }

      const category = await getCategoryById(note.category_id);
      await dispatchNoteFile({
        chatId,
        note,
        categoryTitle: category?.title || 'Library Collection',
      });
      return;
    }

    // ---------------------------------------------------------
    // Admin Panel (Role Gated)
    // ---------------------------------------------------------
    case 'adm': {
      if (!isAdmin(user, superAdminId)) {
        await answerCallback(queryId, '⛔️ Access denied: Admins only.', true);
        return;
      }

      const sub = args[0] || 'menu';
      await answerCallback(queryId);

      // Admin Dashboard Menu
      if (sub === 'menu') {
        const text = `⚙️ <b>Admin Dashboard</b>\n\n` +
          `Welcome, <b>${escapeHtml(user.full_name)}</b>. Select a management tool:`;

        const keyboard = [
          [
            { text: '📊 Analytics & Stats', callback_data: 'adm:stats' },
            { text: '➕ Upload Note / File', callback_data: 'adm:add_note' },
          ],
          [
            { text: '📁 Manage Categories', callback_data: 'adm:cats' },
            { text: '👤 Add New Admin', callback_data: 'adm:add_admin' },
          ],
          [
            { text: '🔙 Back to Main Menu', callback_data: 'back:main' },
          ],
        ];

        await safeEditMessage({
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: { inline_keyboard: keyboard },
          parse_mode: 'HTML',
        });
        return;
      }

      // Admin Analytics
      if (sub === 'stats') {
        const stats = await getAnalytics();
        const text = `📊 <b>Broca Library Analytics</b>\n\n` +
          `👥 <b>Registered Users:</b> <code>${stats.userCount}</code>\n` +
          `📁 <b>Categories:</b> <code>${stats.categoryCount}</code>\n` +
          `📚 <b>Stored Notes & Files:</b> <code>${stats.noteCount}</code>\n\n` +
          `<i>All files hosted securely on Telegram Cloud Storage.</i>`;

        await safeEditMessage({
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to Admin Dashboard', callback_data: 'adm:menu' }],
            ],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      // Admin Add Admin Prompt (FSM start)
      if (sub === 'add_admin') {
        await setUserState(user.id, 'WAIT_ADMIN_ID');
        await safeEditMessage({
          chat_id: chatId,
          message_id: messageId,
          text: `👤 <b>Promote New Admin</b>\n\n` +
            `Please send the <b>numeric Telegram User ID</b> of the target user, or <b>forward a message</b> from them.\n\n` +
            `<i>Tap Cancel to abort:</i>`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      // Admin Manage Categories
      if (sub === 'cats') {
        await editCategoriesView({
          chatId,
          messageId,
          page: 1,
          user,
          superAdminId,
          adminMode: true,
        });
        return;
      }

      // Admin Create New Category (FSM start)
      if (sub === 'new_cat') {
        await setUserState(user.id, 'WAIT_NEW_CAT_NAME', { flow: 'manage_cats' });
        await safeEditMessage({
          chat_id: chatId,
          message_id: messageId,
          text: `📁 <b>Create New Category</b>\n\n` +
            `Please type and send the title for the new category:`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      // Admin Add Note - Step 1: Category Picker
      if (sub === 'add_note') {
        const { categories } = await getCategories(1, 20);

        const keyboard = categories.map((cat) => [
          { text: `📁 ${truncateText(cat.title, 25)}`, callback_data: `adm_sel_cat:${cat.id}` },
        ]);

        keyboard.push([
          { text: '➕ Create New Category', callback_data: 'adm:new_cat_for_note' },
        ]);
        keyboard.push([
          { text: '❌ Cancel', callback_data: 'cancel' },
        ]);

        await setUserState(user.id, 'WAIT_NOTE_CAT', { flow: 'add_note' });

        await safeEditMessage({
          chat_id: chatId,
          message_id: messageId,
          text: `➕ <b>Upload Note - Step 1 of 3: Select Category</b>\n\n` +
            `Select a category for your note, or click ➕ to create a new one:`,
          reply_markup: { inline_keyboard: keyboard },
          parse_mode: 'HTML',
        });
        return;
      }

      // Admin Add Note - Step 1 (Create New Category branch)
      if (sub === 'new_cat_for_note') {
        await setUserState(user.id, 'WAIT_NEW_CAT_NAME', { flow: 'add_note' });
        await safeEditMessage({
          chat_id: chatId,
          message_id: messageId,
          text: `📁 <b>Create New Category for Note</b>\n\n` +
            `Please type and send the title for the new category:`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
          },
          parse_mode: 'HTML',
        });
        return;
      }

      return;
    }

    // Admin Category Pagination: cb: "adm_cp:<page>"
    case 'adm_cp': {
      if (!isAdmin(user, superAdminId)) return;
      const page = Number(args[0]) || 1;
      await answerCallback(queryId);
      await editCategoriesView({
        chatId,
        messageId,
        page,
        user,
        superAdminId,
        adminMode: true,
      });
      return;
    }

    // Admin Selected Existing Category for Note: cb: "adm_sel_cat:<id>"
    case 'adm_sel_cat': {
      if (!isAdmin(user, superAdminId)) return;
      const catId = Number(args[0]);
      const cat = await getCategoryById(catId);
      if (!cat) {
        await answerCallback(queryId, 'Category not found.', true);
        return;
      }

      await answerCallback(queryId);
      await setUserState(user.id, 'WAIT_NOTE_TITLE', {
        flow: 'add_note',
        category_id: cat.id,
        category_title: cat.title,
      });

      await safeEditMessage({
        chat_id: chatId,
        message_id: messageId,
        text: `➕ <b>Upload Note - Step 2 of 3: Note Title</b>\n\n` +
          `📁 <b>Category:</b> ${escapeHtml(cat.title)}\n\n` +
          `Please send the display title for this note/file:`,
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]],
        },
        parse_mode: 'HTML',
      });
      return;
    }

    // ---------------------------------------------------------
    // Content Deletion Flows (with Confirmation)
    // ---------------------------------------------------------
    // Click category in Admin Mode -> asks confirmation to delete or view
    case 'del_c': {
      if (!isAdmin(user, superAdminId)) return;
      const catId = Number(args[0]);
      const cat = await getCategoryById(catId);
      if (!cat) {
        await answerCallback(queryId, 'Category not found.', true);
        return;
      }

      await answerCallback(queryId);
      await safeEditMessage({
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ <b>Delete Category:</b> ${escapeHtml(cat.title)}?\n\n` +
          `<b>Warning:</b> Deleting this category will cascade-delete all notes stored within it.\n` +
          `Are you sure?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📁 View Files', callback_data: `adm_notes:${cat.id}` },
              { text: '🗑 Yes, Delete', callback_data: `cnf_del_c:${cat.id}` },
            ],
            [{ text: '❌ Cancel', callback_data: 'adm:cats' }],
          ],
        },
        parse_mode: 'HTML',
      });
      return;
    }

    // Confirmed Delete Category: cb: "cnf_del_c:<id>"
    case 'cnf_del_c': {
      if (!isAdmin(user, superAdminId)) return;
      const catId = Number(args[0]);
      await deleteCategory(catId);
      await answerCallback(queryId, 'Category deleted successfully.');
      await editCategoriesView({
        chatId,
        messageId,
        page: 1,
        user,
        superAdminId,
        adminMode: true,
      });
      return;
    }

    // Admin Browse Notes in Category: cb: "adm_notes:<cat_id>"
    case 'adm_notes': {
      if (!isAdmin(user, superAdminId)) return;
      const catId = Number(args[0]);
      await answerCallback(queryId);
      await editNotesView({
        chatId,
        messageId,
        categoryId: catId,
        page: 1,
        adminMode: true,
      });
      return;
    }

    // Click note in Admin Mode -> asks confirmation to delete
    case 'del_n': {
      if (!isAdmin(user, superAdminId)) return;
      const noteId = Number(args[0]);
      const note = await getNoteById(noteId);
      if (!note) {
        await answerCallback(queryId, 'File not found.', true);
        return;
      }

      await answerCallback(queryId);
      await safeEditMessage({
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ <b>Delete File:</b> ${escapeHtml(note.title)}?\n\n` +
          `File: <code>${escapeHtml(note.file_name || 'N/A')}</code>\n` +
          `Size: <code>${formatFileSize(note.file_size)}</code>\n\n` +
          `Are you sure you want to delete this file?`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Yes, Delete File', callback_data: `cnf_del_n:${note.id}` }],
            [{ text: '❌ Cancel', callback_data: `adm_notes:${note.category_id}` }],
          ],
        },
        parse_mode: 'HTML',
      });
      return;
    }

    // Confirmed Delete Note: cb: "cnf_del_n:<id>"
    case 'cnf_del_n': {
      if (!isAdmin(user, superAdminId)) return;
      const noteId = Number(args[0]);
      const note = await getNoteById(noteId);
      const catId = note ? note.category_id : null;

      await deleteNote(noteId);
      await answerCallback(queryId, 'File deleted successfully.');

      if (catId) {
        await editNotesView({
          chatId,
          messageId,
          categoryId: catId,
          page: 1,
          adminMode: true,
        });
      } else {
        await editCategoriesView({
          chatId,
          messageId,
          page: 1,
          user,
          superAdminId,
          adminMode: true,
        });
      }
      return;
    }

    default: {
      await answerCallback(queryId);
    }
  }
}
