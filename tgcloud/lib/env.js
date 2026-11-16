/**
 * Environment configuration reader for Broca Library Bot.
 * Retrieves SUPER_ADMIN_ID from Telegram Serverless environment (sdk/env)
 * or process.env when running tests.
 */

let cachedSuperAdminId = null;

export async function getSuperAdminId() {
  if (cachedSuperAdminId !== null) {
    return cachedSuperAdminId;
  }

  // 1. Try reading from sdk/env
  try {
    const envModule = await import('sdk/env');
    const id = envModule.SUPER_ADMIN_ID || envModule.env?.SUPER_ADMIN_ID || envModule.default?.SUPER_ADMIN_ID;
    if (id) {
      cachedSuperAdminId = String(id).trim();
      return cachedSuperAdminId;
    }
  } catch {
    // sdk/env not available in current environment
  }

  // 2. Try reading from global process.env (Node / test runner)
  if (typeof process !== 'undefined' && process.env && process.env.SUPER_ADMIN_ID) {
    cachedSuperAdminId = String(process.env.SUPER_ADMIN_ID).trim();
    return cachedSuperAdminId;
  }

  return '';
}

/**
 * Reset cached SUPER_ADMIN_ID (useful for testing different roles)
 */
export function setCachedSuperAdminId(id) {
  cachedSuperAdminId = id ? String(id).trim() : '';
}
