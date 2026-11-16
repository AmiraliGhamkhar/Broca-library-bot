/**
 * Broca Digital Library Bot - Database Access Layer
 * Built on sdk/db (SQLite) for Telegram Serverless (@tgcloud).
 */

import { db } from 'sdk';
import { eq, sql, desc, asc } from 'sdk/db';
import { users, categories, notes } from '../schema.js';

/**
 * Format full name from Telegram user object.
 */
export function formatFullName(fromUser) {
  if (!fromUser) return 'User';
  const nameParts = [fromUser.first_name, fromUser.last_name].filter(Boolean);
  if (nameParts.length > 0) return nameParts.join(' ');
  return fromUser.username ? `@${fromUser.username}` : `User ${fromUser.id}`;
}

/**
 * Get user by Telegram user ID.
 *
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
export async function getUser(userId) {
  if (!userId) return null;
  const row = await db.select().from(users).where(eq(users.id, Number(userId))).get();
  return row || null;
}

/**
 * Upsert user on incoming update (user onboarding / update middleware).
 *
 * @param {object} fromUser - Telegram User object (message.from or query.from)
 * @param {string|number} [superAdminId] - SUPER_ADMIN_ID from environment
 * @param {object} [options]
 * @param {boolean} [options.forceResetState=false] - Whether to reset FSM state to 'IDLE'
 * @returns {Promise<object>} The updated user record
 */
export async function upsertUser(fromUser, superAdminId = '', options = {}) {
  if (!fromUser || !fromUser.id) {
    throw new Error('upsertUser: fromUser object with valid id is required');
  }

  const userId = Number(fromUser.id);
  const fullName = formatFullName(fromUser);
  const isSuperAdmin = superAdminId && String(userId) === String(superAdminId);

  // Check if user already exists to preserve role unless elevated by SUPER_ADMIN_ID
  const existing = await getUser(userId);

  let role = existing?.role || 'user';
  if (isSuperAdmin) {
    role = 'admin';
  }

  const shouldResetState = options.forceResetState === true;
  const state = shouldResetState ? 'IDLE' : (existing?.state || 'IDLE');
  const tempData = shouldResetState ? null : (existing?.temp_data ?? null);

  const valuesToInsert = {
    id: userId,
    full_name: fullName,
    role,
    state,
    temp_data: tempData,
  };

  const updateSet = {
    full_name: fullName,
    role,
  };

  if (shouldResetState) {
    updateSet.state = 'IDLE';
    updateSet.temp_data = null;
  }

  await db.insert(users)
    .values(valuesToInsert)
    .onConflictDoUpdate({
      target: users.id,
      set: updateSet,
    })
    .run();

  return (await getUser(userId)) || valuesToInsert;
}

/**
 * Set user's FSM state and intermediate temporary data.
 *
 * @param {number} userId
 * @param {string} state - FSM state (e.g. 'IDLE', 'WAIT_NOTE_FILE')
 * @param {string|object|null} [tempData=null] - JSON string or object
 */
export async function setUserState(userId, state = 'IDLE', tempData = null) {
  const serialized = typeof tempData === 'object' && tempData !== null
    ? JSON.stringify(tempData)
    : (tempData ?? null);

  await db.update(users)
    .set({
      state,
      temp_data: serialized,
    })
    .where(eq(users.id, Number(userId)))
    .run();
}

/**
 * Promote or demote user role.
 *
 * @param {number} userId
 * @param {'user'|'admin'} role
 */
export async function setUserRole(userId, role = 'admin') {
  await db.update(users)
    .set({ role })
    .where(eq(users.id, Number(userId)))
    .run();
}

/**
 * Fetch paginated categories.
 *
 * @param {number} [page=1]
 * @param {number} [limit=8]
 * @returns {Promise<{ categories: Array<object>, totalCount: number, totalPages: number, currentPage: number }>}
 */
export async function getCategories(page = 1, limit = 8) {
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const [categoryList, totalCount] = await Promise.all([
    db.select()
      .from(categories)
      .orderBy(asc(categories.title))
      .limit(limit)
      .offset(offset)
      .all(),
    db.$count ? db.$count(categories) : (async () => {
      const res = await db.get(sql`SELECT count(*) AS c FROM categories`);
      return res?.c || 0;
    })(),
  ]);

  const count = Number(totalCount) || 0;
  const totalPages = Math.max(1, Math.ceil(count / limit));

  return {
    categories: categoryList || [],
    totalCount: count,
    totalPages,
    currentPage,
  };
}

/**
 * Get category by ID.
 *
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getCategoryById(id) {
  if (!id) return null;
  const row = await db.select().from(categories).where(eq(categories.id, Number(id))).get();
  return row || null;
}

/**
 * Create a new category.
 *
 * @param {string} title
 * @returns {Promise<object>}
 */
export async function createCategory(title) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('Category title cannot be empty');

  // Insert into categories table
  const inserted = await db.insert(categories)
    .values({ title: cleanTitle })
    .returning()
    .run();

  if (Array.isArray(inserted) && inserted.length > 0) {
    return inserted[0];
  }

  // Fallback lookup
  return (await db.select().from(categories).where(eq(categories.title, cleanTitle)).get()) || { title: cleanTitle };
}

/**
 * Delete a category and logically cascade delete all associated notes.
 *
 * @param {number} categoryId
 */
export async function deleteCategory(categoryId) {
  const catId = Number(categoryId);
  // Application-level cascade: delete notes in this category first
  await db.delete(notes).where(eq(notes.category_id, catId)).run();
  // Delete category
  await db.delete(categories).where(eq(categories.id, catId)).run();
}

/**
 * Fetch paginated notes for a specific category.
 *
 * @param {number} categoryId
 * @param {number} [page=1]
 * @param {number} [limit=8]
 * @returns {Promise<{ notes: Array<object>, totalCount: number, totalPages: number, currentPage: number }>}
 */
export async function getNotesByCategory(categoryId, page = 1, limit = 8) {
  const catId = Number(categoryId);
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const [notesList, totalCount] = await Promise.all([
    db.select()
      .from(notes)
      .where(eq(notes.category_id, catId))
      .orderBy(desc(notes.id))
      .limit(limit)
      .offset(offset)
      .all(),
    db.$count
      ? db.$count(notes, eq(notes.category_id, catId))
      : (async () => {
          const res = await db.get(sql`SELECT count(*) AS c FROM notes WHERE category_id = ${catId}`);
          return res?.c || 0;
        })(),
  ]);

  const count = Number(totalCount) || 0;
  const totalPages = Math.max(1, Math.ceil(count / limit));

  return {
    notes: notesList || [],
    totalCount: count,
    totalPages,
    currentPage,
  };
}

/**
 * Get note by ID.
 *
 * @param {number} noteId
 * @returns {Promise<object|null>}
 */
export async function getNoteById(noteId) {
  if (!noteId) return null;
  const row = await db.select().from(notes).where(eq(notes.id, Number(noteId))).get();
  return row || null;
}

/**
 * Insert a new note into the library.
 *
 * @param {object} params
 * @param {number} params.category_id
 * @param {string} params.title
 * @param {string} params.file_id
 * @param {'document'|'photo'|'video'|'audio'} params.file_type
 * @param {string} [params.file_name]
 * @param {number} [params.file_size]
 * @returns {Promise<object>}
 */
export async function createNote({
  category_id,
  title,
  file_id,
  file_type,
  file_name,
  file_size,
}) {
  const values = {
    category_id: Number(category_id),
    title: String(title || '').trim(),
    file_id: String(file_id || ''),
    file_type: String(file_type || 'document'),
    file_name: file_name || null,
    file_size: Number(file_size) || 0,
  };

  const inserted = await db.insert(notes).values(values).returning().run();
  if (Array.isArray(inserted) && inserted.length > 0) {
    return inserted[0];
  }
  return values;
}

/**
 * Delete note by ID.
 *
 * @param {number} noteId
 */
export async function deleteNote(noteId) {
  await db.delete(notes).where(eq(notes.id, Number(noteId))).run();
}

/**
 * Query library analytics for admin panel.
 *
 * @returns {Promise<{ userCount: number, categoryCount: number, noteCount: number }>}
 */
export async function getAnalytics() {
  const [usersCount, categoriesCount, notesCount] = await Promise.all([
    db.$count ? db.$count(users) : db.get(sql`SELECT count(*) AS c FROM users`).then((r) => r?.c || 0),
    db.$count ? db.$count(categories) : db.get(sql`SELECT count(*) AS c FROM categories`).then((r) => r?.c || 0),
    db.$count ? db.$count(notes) : db.get(sql`SELECT count(*) AS c FROM notes`).then((r) => r?.c || 0),
  ]);

  return {
    userCount: Number(usersCount) || 0,
    categoryCount: Number(categoriesCount) || 0,
    noteCount: Number(notesCount) || 0,
  };
}
