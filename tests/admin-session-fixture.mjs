import { createHmac } from 'node:crypto';

export const adminCredentials = {
  ADMIN_PASSWORD: 'test-password',
  ADMIN_SESSION_KEY: 'ab'.repeat(32),
};

// Keep existing deterministic route cookies while filling KV as a login would.
export function adminSessionEnv(token = 'a'.repeat(32)) {
  const signature = createHmac('sha256', adminCredentials.ADMIN_SESSION_KEY)
    .update(JSON.stringify(['gb-session-v1', token, adminCredentials.ADMIN_PASSWORD]))
    .digest('hex');
  return {
    ...adminCredentials,
    SESSIONS: { get: async key => key === 'session:' + token ? 'v1:' + signature : null },
  };
}
