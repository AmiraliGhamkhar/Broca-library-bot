/**
 * Database Schema Definition for Broca Digital Library Bot
 * Deployed natively on Telegram Serverless (@tgcloud) with SQLite (sdk/db).
 *
 * NOTE ON CONSTRAINTS:
 * 1. The Telegram Serverless runtime operates with `PRAGMA foreign_keys = OFF`.
 *    Calling `.references()` or `foreignKey()` throws an error during declaration.
 *    Relational integrity between `notes.category_id` and `categories.id` is
 *    enforced logically in application code.
 * 2. SQLite tables are exported as named exports as required by @tgcloud discovery.
 */

import { table, integer, text, index, sql } from 'sdk/db';

/**
 * Users Table
 * Tracks bot users, roles, and finite state machine (FSM) state for stateless execution.
 */
export const users = table('users', {
  // Telegram User ID
  id: integer('id').primaryKey(),

  // Telegram User Full Name / First Name
  full_name: text('full_name'),

  // Role: 'user' | 'admin'
  role: text('role').default('user'),

  // FSM State: 'IDLE' | 'WAIT_ADMIN_ID' | 'WAIT_NOTE_CAT' | 'WAIT_NEW_CAT_NAME' | 'WAIT_NOTE_TITLE' | 'WAIT_NOTE_FILE'
  state: text('state').default('IDLE'),

  // JSON string holding intermediate multi-step wizard data during FSM transitions
  temp_data: text('temp_data'),

  // Unix timestamp (seconds) when user was registered
  created_at: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  roleIdx: index('idx_users_role').on(t.role),
  stateIdx: index('idx_users_state').on(t.state),
}));

/**
 * Categories Table
 * Stores library categories for organizing files.
 */
export const categories = table('categories', {
  // Auto-incrementing Category ID
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Unique human-readable Category title
  title: text('title').notNull().unique(),
});

/**
 * Notes (Files) Table
 * Stores file records mapped to Telegram cloud storage file IDs.
 */
export const notes = table('notes', {
  // Auto-incrementing Note ID
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Logical reference to categories.id (integrity maintained at app level)
  category_id: integer('category_id').notNull(),

  // Display title shown on inline keyboard buttons
  title: text('title').notNull(),

  // Telegram cloud file_id for one-click downloads
  file_id: text('file_id').notNull(),

  // File type: 'document' | 'photo' | 'video' | 'audio'
  file_type: text('file_type').notNull(),

  // Original file name (e.g. 'Lecture_01.pdf')
  file_name: text('file_name'),

  // File size in bytes
  file_size: integer('file_size'),

  // Unix timestamp (seconds) when note was uploaded
  created_at: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  categoryIdx: index('idx_notes_category_id').on(t.category_id),
}));
