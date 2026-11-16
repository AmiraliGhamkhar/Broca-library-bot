/**
 * Broca Digital Library Bot - Main Entry Point Router
 * Deployed natively on Telegram Serverless (@tgcloud).
 */

import { handleMessage, handleCallbackQuery } from './lib/router.js';
import { upsertUser, getUser } from './lib/db.js';
import { getSuperAdminId } from './lib/env.js';

/**
 * Master update dispatcher.
 * Handles both Telegram update objects and individual update payloads.
 *
 * @param {object} payload - Telegram Update or Update Payload (Message / CallbackQuery)
 * @param {object} [ctx] - Serverless execution context (containing ctx.update)
 */
export async function handleUpdate(payload, ctx = {}) {
  if (!payload) return;

  // Case 1: Full Telegram Update object
  if (payload.message) {
    return await handleMessage(payload.message, ctx);
  }
  if (payload.callback_query) {
    return await handleCallbackQuery(payload.callback_query, ctx);
  }

  // Case 2: Individual update payload passed directly
  if (payload.chat && (payload.text !== undefined || payload.document || payload.photo || payload.video || payload.audio)) {
    return await handleMessage(payload, ctx);
  }
  if (payload.data !== undefined && payload.id) {
    return await handleCallbackQuery(payload, ctx);
  }

  // Fallback to checking ctx.update
  if (ctx && ctx.update) {
    if (ctx.update.message) return await handleMessage(ctx.update.message, ctx);
    if (ctx.update.callback_query) return await handleCallbackQuery(ctx.update.callback_query, ctx);
  }
}

export default async function (payload, ctx) {
  return await handleUpdate(payload, ctx);
}

export {
  handleMessage,
  handleCallbackQuery,
  upsertUser,
  getUser,
  getSuperAdminId,
};
