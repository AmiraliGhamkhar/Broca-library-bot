/**
 * Broca Digital Library Bot - Helper Utilities
 * Deployed natively on Telegram Serverless (@tgcloud).
 *
 * Provides:
 * - extractFileMeta: Unified extractor for document, photo, video, and audio objects
 * - escapeHtml / escapeMarkdownV2: Escapers to prevent Telegram API 400 Bad Request
 * - formatFileSize: Byte size formatter (B, KB, MB)
 * - buildPaginationKeyboard: Generic Telegram InlineKeyboard pagination generator
 * - buildCategoriesKeyboard / buildNotesKeyboard: Domain-specific keyboard builders
 * - parseCallbackData: Compact callback_data parser respecting the 64-byte hard limit
 * - isAdmin: Role-based access control evaluator
 */

/**
 * Extract unified file metadata from any Telegram Message object.
 * Supports document, photo, video, audio, voice, and animation.
 *
 * @param {object} message - Telegram Message object (update.message)
 * @returns {{ file_id: string, file_type: 'document' | 'photo' | 'video' | 'audio', file_name: string, file_size: number } | null}
 */
export function extractFileMeta(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  // 1. Documents (PDF, DOCX, XLSX, ZIP, etc.)
  if (message.document) {
    const doc = message.document;
    return {
      file_id: doc.file_id,
      file_type: 'document',
      file_name: doc.file_name || 'document',
      file_size: Number(doc.file_size) || 0,
    };
  }

  // 2. Photos (Telegram sends an array of PhotoSize; last item is highest resolution)
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    const uniqueId = photo.file_unique_id ? `_${photo.file_unique_id}` : '';
    return {
      file_id: photo.file_id,
      file_type: 'photo',
      file_name: `photo${uniqueId}.jpg`,
      file_size: Number(photo.file_size) || 0,
    };
  }

  // 3. Videos
  if (message.video) {
    const vid = message.video;
    const uniqueId = vid.file_unique_id ? `_${vid.file_unique_id}` : '';
    return {
      file_id: vid.file_id,
      file_type: 'video',
      file_name: vid.file_name || `video${uniqueId}.mp4`,
      file_size: Number(vid.file_size) || 0,
    };
  }

  // 4. Audio (Music, MP3, etc.)
  if (message.audio) {
    const aud = message.audio;
    let name = aud.file_name;
    if (!name) {
      if (aud.title && aud.performer) {
        name = `${aud.performer} - ${aud.title}.mp3`;
      } else if (aud.title) {
        name = `${aud.title}.mp3`;
      } else {
        const uniqueId = aud.file_unique_id ? `_${aud.file_unique_id}` : '';
        name = `audio${uniqueId}.mp3`;
      }
    }
    return {
      file_id: aud.file_id,
      file_type: 'audio',
      file_name: name,
      file_size: Number(aud.file_size) || 0,
    };
  }

  // 5. Voice Notes (Treated as audio)
  if (message.voice) {
    const voice = message.voice;
    const uniqueId = voice.file_unique_id ? `_${voice.file_unique_id}` : '';
    return {
      file_id: voice.file_id,
      file_type: 'audio',
      file_name: `voice${uniqueId}.ogg`,
      file_size: Number(voice.file_size) || 0,
    };
  }

  // 6. Animation / GIF (Treated as document/video)
  if (message.animation) {
    const anim = message.animation;
    const uniqueId = anim.file_unique_id ? `_${anim.file_unique_id}` : '';
    return {
      file_id: anim.file_id,
      file_type: 'document',
      file_name: anim.file_name || `animation${uniqueId}.mp4`,
      file_size: Number(anim.file_size) || 0,
    };
  }

  return null;
}

/**
 * Safely escape HTML characters for Telegram HTML parse_mode.
 * Prevents 400 Bad Request errors when rendering titles or filenames.
 *
 * @param {string|number|null|undefined} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Safely escape MarkdownV2 special characters for Telegram.
 *
 * @param {string|number|null|undefined} text
 * @returns {string}
 */
export function escapeMarkdownV2(text) {
  if (text == null) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Format bytes into human-readable size (B, KB, MB).
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';

  if (num < 1024) {
    return `${num} B`;
  }
  if (num < 1024 * 1024) {
    return `${(num / 1024).toFixed(1)} KB`;
  }
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Truncate a string to a maximum length with ellipsis.
 * Helpful for keeping inline keyboard button labels clean.
 *
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
export function truncateText(text, maxLength = 30) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

/**
 * Generic Telegram Inline Keyboard Pagination Builder.
 * Ensures callback_data remains strictly under the 64-byte Telegram limit.
 *
 * @param {object} options
 * @param {Array<any>} options.items - Items to display on the current page
 * @param {number} options.currentPage - 1-based current page index
 * @param {number} options.totalPages - Total number of pages
 * @param {(item: any) => { text: string, callback_data: string }} options.getItemButton - Button mapper
 * @param {(targetPage: number) => string} options.getPageCallback - Function returning callback_data for page target
 * @param {number} [options.itemsPerRow=1] - Number of items per row (1 or 2)
 * @param {Array<Array<{ text: string, callback_data: string }>>} [options.extraRows=[]] - Additional action rows
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }}
 */
export function buildPaginationKeyboard({
  items,
  currentPage,
  totalPages,
  getItemButton,
  getPageCallback,
  itemsPerRow = 1,
  extraRows = [],
}) {
  const keyboard = [];

  // 1. Render item buttons
  const normalizedItems = Array.isArray(items) ? items : [];
  let currentRow = [];

  for (let i = 0; i < normalizedItems.length; i++) {
    const item = normalizedItems[i];
    const btn = getItemButton(item);
    if (btn && btn.text && btn.callback_data) {
      // Validate 64-byte hard limit on callback_data
      if (Buffer.byteLength(btn.callback_data, 'utf8') > 64) {
        console.warn(`[WARN] callback_data exceeds 64 bytes: ${btn.callback_data}`);
      }
      currentRow.push(btn);
      if (currentRow.length >= itemsPerRow) {
        keyboard.push(currentRow);
        currentRow = [];
      }
    }
  }
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }

  // 2. Render pagination navigation bar if totalPages > 1
  if (totalPages > 1) {
    const navRow = [];

    // 'Previous' button
    if (currentPage > 1) {
      navRow.push({
        text: '◀️ Prev',
        callback_data: getPageCallback(currentPage - 1),
      });
    }

    // Page indicator (noop callback)
    navRow.push({
      text: `📄 ${currentPage}/${totalPages}`,
      callback_data: 'noop',
    });

    // 'Next' button
    if (currentPage < totalPages) {
      navRow.push({
        text: 'Next ▶️',
        callback_data: getPageCallback(currentPage + 1),
      });
    }

    keyboard.push(navRow);
  }

  // 3. Append extra control rows (Back, Add, Cancel, etc.)
  if (Array.isArray(extraRows)) {
    for (const row of extraRows) {
      if (Array.isArray(row) && row.length > 0) {
        keyboard.push(row);
      }
    }
  }

  return { inline_keyboard: keyboard };
}

/**
 * Build Inline Keyboard for Category Browsing.
 * Compact callback format:
 * - "c:<id>" -> Open category notes
 * - "cp:<page>" -> Category page navigation
 * - "del_c:<id>" -> Delete category (admin mode)
 *
 * @param {object} params
 * @param {Array<{ id: number, title: string }>} params.categories
 * @param {number} params.currentPage
 * @param {number} params.totalPages
 * @param {boolean} [params.isAdmin=false]
 * @param {boolean} [params.adminMode=false]
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }}
 */
export function buildCategoriesKeyboard({
  categories,
  currentPage = 1,
  totalPages = 1,
  isAdmin = false,
  adminMode = false,
}) {
  const extraRows = [];

  if (adminMode) {
    extraRows.push([
      { text: '➕ New Category', callback_data: 'adm:new_cat' },
    ]);
    extraRows.push([
      { text: '🔙 Back to Admin Panel', callback_data: 'adm:menu' },
    ]);
  } else {
    if (isAdmin) {
      extraRows.push([
        { text: '⚙️ Admin Panel', callback_data: 'adm:menu' },
      ]);
    }
    extraRows.push([
      { text: '🔙 Back to Main Menu', callback_data: 'back:main' },
    ]);
  }

  return buildPaginationKeyboard({
    items: categories,
    currentPage,
    totalPages,
    itemsPerRow: 2, // 2 categories per row for clean mobile layout
    getItemButton: (cat) => ({
      text: adminMode ? `🗑 ${truncateText(cat.title, 18)}` : `📁 ${truncateText(cat.title, 20)}`,
      callback_data: adminMode ? `del_c:${cat.id}` : `c:${cat.id}`,
    }),
    getPageCallback: (page) => (adminMode ? `adm_cp:${page}` : `cp:${page}`),
    extraRows,
  });
}

/**
 * Build Inline Keyboard for Notes inside a Category.
 * Compact callback format:
 * - "dl:<id>" -> Trigger 1-click file download
 * - "np:<cat_id>:<page>" -> Notes page navigation
 * - "del_n:<id>" -> Delete note (admin mode)
 *
 * @param {object} params
 * @param {Array<{ id: number, title: string, file_type: string, file_size: number }>} params.notes
 * @param {number} params.categoryId
 * @param {number} params.currentPage
 * @param {number} params.totalPages
 * @param {boolean} [params.adminMode=false]
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }}
 */
export function buildNotesKeyboard({
  notes,
  categoryId,
  currentPage = 1,
  totalPages = 1,
  adminMode = false,
}) {
  const typeIcons = {
    document: '📄',
    photo: '🖼',
    video: '🎥',
    audio: '🎵',
  };

  const extraRows = [
    [
      {
        text: '🔙 Back to Categories',
        callback_data: adminMode ? 'adm:del_cat_list' : 'back:cats',
      },
    ],
  ];

  return buildPaginationKeyboard({
    items: notes,
    currentPage,
    totalPages,
    itemsPerRow: 1, // 1 file per row so file title & size are readable
    getItemButton: (note) => {
      const icon = typeIcons[note.file_type] || '📎';
      const sizeStr = note.file_size ? ` (${formatFileSize(note.file_size)})` : '';
      const displayTitle = truncateText(note.title, 24);

      return {
        text: adminMode
          ? `🗑 ${displayTitle}${sizeStr}`
          : `${icon} ${displayTitle}${sizeStr}`,
        callback_data: adminMode ? `del_n:${note.id}` : `dl:${note.id}`,
      };
    },
    getPageCallback: (page) => `np:${categoryId}:${page}`,
    extraRows,
  });
}

/**
 * Check if a user has admin privileges.
 *
 * @param {{ id: number, role?: string } | null | undefined} user
 * @param {string|number|null|undefined} superAdminId
 * @returns {boolean}
 */
export function isAdmin(user, superAdminId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (superAdminId && String(user.id) === String(superAdminId)) return true;
  return false;
}

/**
 * Parse compact callback_data payload.
 *
 * @param {string} data
 * @returns {{ action: string, args: string[], raw: string }}
 */
export function parseCallbackData(data) {
  if (!data || typeof data !== 'string') {
    return { action: '', args: [], raw: '' };
  }
  const parts = data.split(':');
  const action = parts[0] || '';
  const args = parts.slice(1);
  return { action, args, raw: data };
}
