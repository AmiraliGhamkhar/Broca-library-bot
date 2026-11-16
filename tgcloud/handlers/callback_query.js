/**
 * Telegram Serverless update handler for `callback_query` updates.
 * Deployed natively to Telegram's isolated V8 runtime.
 */

import { handleCallbackQuery } from '../lib/router.js';

export default async function (query, ctx) {
  return await handleCallbackQuery(query, ctx);
}
