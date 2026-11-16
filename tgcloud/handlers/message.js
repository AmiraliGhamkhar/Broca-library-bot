/**
 * Telegram Serverless update handler for `message` updates.
 * Deployed natively to Telegram's isolated V8 runtime.
 */

import { handleMessage } from '../lib/router.js';

export default async function (message, ctx) {
  return await handleMessage(message, ctx);
}
