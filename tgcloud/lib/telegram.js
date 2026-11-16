/**
 * Broca Digital Library Bot - Telegram API Dispatcher
 * Decouples Telegram API wrapper calls from business logic.
 * Adheres to Telegram Serverless Bot API patterns and error handling.
 */

import { api, BotApiError } from 'sdk';
import {
  escapeHtml,
  formatFileSize,
  isAdmin,
  buildCategoriesKeyboard,
  buildNotesKeyboard,
} from './helpers.js';
import {
  getCategories,
  getCategoryById,
  getNotesByCategory,
} from './db.js';

/**
 * Answer callback query safely so the Telegram client doesn't show a spinner.
 *
 * @param {string} callbackQueryId
 * @param {string} [text='']
 * @param {boolean} [showAlert=false]
 */
export async function answerCallback(callbackQueryId, text = '', showAlert = false) {
  if (!callbackQueryId) return;
  try {
    const params = { callback_query_id: callbackQueryId };
    if (text) {
      params.text = text;
      params.show_alert = showAlert;
    }
    await api.answerCallbackQuery(params);
  } catch (err) {
    // Callback queries expire after a few minutes; ignore expired query errors
    console.warn(`[WARN] Failed to answer callback query: ${err.message}`);
  }
}

/**
 * Edit message text safely, ignoring "message is not modified" errors.
 *
 * @param {object} params
 * @param {number|string} params.chat_id
 * @param {number} params.message_id
 * @param {string} params.text
 * @param {object} [params.reply_markup]
 * @param {string} [params.parse_mode='HTML']
 */
export async function safeEditMessage({ chat_id, message_id, text, reply_markup, parse_mode = 'HTML' }) {
  try {
    return await api.editMessageText({
      chat_id,
      message_id,
      text,
      reply_markup,
      parse_mode,
    });
  } catch (err) {
    if (err instanceof BotApiError || err?.description) {
      const desc = err.description || err.message;
      if (desc.includes('message is not modified')) {
        // Safe to ignore duplicate edits
        return null;
      }
    }
    throw err;
  }
}

/**
 * Build Main Menu payload (text and inline keyboard).
 *
 * @param {object} user
 * @param {string} superAdminId
 * @returns {{ text: string, reply_markup: object }}
 */
export function buildMainMenuPayload(user, superAdminId) {
  const name = escapeHtml(user?.full_name || 'Book Lover');
  const adminAccess = isAdmin(user, superAdminId);

  const text = `👋 <b>Welcome to Broca Digital Library, ${name}!</b>\n\n` +
    `Explore our curated repository of books, lecture notes, academic documents, audio, and media.\n\n` +
    `Tap <b>📚 Browse Library</b> to browse categories and download materials instantly.`;

  const keyboard = [
    [
      { text: '📚 Browse Library', callback_data: 'lib:cats' },
    ],
  ];

  if (adminAccess) {
    keyboard.push([
      { text: '⚙️ Admin Panel', callback_data: 'adm:menu' },
    ]);
  }

  return {
    text,
    reply_markup: { inline_keyboard: keyboard },
  };
}

/**
 * Send Main Menu message.
 */
export async function sendMainMenu(chatId, user, superAdminId) {
  const payload = buildMainMenuPayload(user, superAdminId);
  return await api.sendMessage({
    chat_id: chatId,
    text: payload.text,
    reply_markup: payload.reply_markup,
    parse_mode: 'HTML',
  });
}

/**
 * Edit existing message to Main Menu.
 */
export async function editMainMenu(chatId, messageId, user, superAdminId) {
  const payload = buildMainMenuPayload(user, superAdminId);
  return await safeEditMessage({
    chat_id: chatId,
    message_id: messageId,
    text: payload.text,
    reply_markup: payload.reply_markup,
    parse_mode: 'HTML',
  });
}

/**
 * Render paginated Category List.
 */
export async function editCategoriesView({
  chatId,
  messageId,
  page = 1,
  user,
  superAdminId,
  adminMode = false,
}) {
  const { categories, totalPages, currentPage } = await getCategories(page, 8);
  const adminAccess = isAdmin(user, superAdminId);

  let text;
  if (categories.length === 0) {
    text = adminMode
      ? `📚 <b>Category Management</b>\n\nNo categories exist yet. Click below to add the first category:`
      : `📚 <b>Digital Library</b>\n\nThere are no categories available in the library yet. Please check back later!`;
  } else {
    text = adminMode
      ? `⚙️ <b>Category Management</b> (Page ${currentPage}/${totalPages})\n\nSelect a category to view its content or delete it:`
      : `📚 <b>Library Categories</b> (Page ${currentPage}/${totalPages})\n\nSelect a category below to explore its available files:`;
  }

  const reply_markup = buildCategoriesKeyboard({
    categories,
    currentPage,
    totalPages,
    isAdmin: adminAccess,
    adminMode,
  });

  return await safeEditMessage({
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup,
    parse_mode: 'HTML',
  });
}

/**
 * Render paginated Notes List inside a Category.
 */
export async function editNotesView({
  chatId,
  messageId,
  categoryId,
  page = 1,
  adminMode = false,
}) {
  const [category, { notes, totalPages, currentPage, totalCount }] = await Promise.all([
    getCategoryById(categoryId),
    getNotesByCategory(categoryId, page, 8),
  ]);

  if (!category) {
    return await safeEditMessage({
      chat_id: chatId,
      message_id: messageId,
      text: `❌ <b>Category not found.</b> It may have been removed.`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to Categories', callback_data: adminMode ? 'adm:del_cat_list' : 'back:cats' }],
        ],
      },
      parse_mode: 'HTML',
    });
  }

  const catTitle = escapeHtml(category.title);
  let text;

  if (notes.length === 0) {
    text = `📁 <b>Category:</b> ${catTitle}\n\n<i>This category does not contain any files yet.</i>`;
  } else {
    text = adminMode
      ? `🗑 <b>Manage Files in:</b> ${catTitle}\nTotal files: <code>${totalCount}</code> (Page ${currentPage}/${totalPages})\n\nTap any file below to delete it:`
      : `📁 <b>Category:</b> ${catTitle}\nTotal files: <code>${totalCount}</code> (Page ${currentPage}/${totalPages})\n\nTap any file below to download it with 1-click:`;
  }

  const reply_markup = buildNotesKeyboard({
    notes,
    categoryId: category.id,
    currentPage,
    totalPages,
    adminMode,
  });

  return await safeEditMessage({
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup,
    parse_mode: 'HTML',
  });
}

/**
 * One-Click File Downloader.
 * Fetches file metadata from SQLite and dispatches media to the user chat.
 *
 * @param {object} params
 * @param {number|string} params.chatId
 * @param {object} params.note
 * @param {string} [params.categoryTitle='Library']
 */
export async function dispatchNoteFile({ chatId, note, categoryTitle = 'Library' }) {
  const title = escapeHtml(note.title);
  const catName = escapeHtml(categoryTitle);
  const size = formatFileSize(note.file_size);

  const caption = `📖 <b>${title}</b>\n` +
    `📁 <b>Category:</b> <i>${catName}</i>\n` +
    `📦 <b>Size:</b> <code>${size}</code>\n\n` +
    `<i>Broca Digital Library</i>`;

  const fileId = note.file_id;
  const fileType = note.file_type;

  switch (fileType) {
    case 'photo':
      return await api.sendPhoto({
        chat_id: chatId,
        photo: fileId,
        caption,
        parse_mode: 'HTML',
      });

    case 'video':
      return await api.sendVideo({
        chat_id: chatId,
        video: fileId,
        caption,
        parse_mode: 'HTML',
      });

    case 'audio':
      return await api.sendAudio({
        chat_id: chatId,
        audio: fileId,
        caption,
        parse_mode: 'HTML',
      });

    case 'document':
    default:
      return await api.sendDocument({
        chat_id: chatId,
        document: fileId,
        caption,
        parse_mode: 'HTML',
      });
  }
}
