import { describe, expect, it } from 'vitest';
import { createNotificationAdapter } from '../../src/services/notifications/notificationAdapter.js';

describe('createNotificationAdapter', () => {
  it('the in-app adapter marks a recipient with a BloodLink account as delivered, and one without as not', async () => {
    const adapter = createNotificationAdapter({ provider: 'inapp' });
    expect(adapter.provider).toBe('inapp');
    const outcomes = await adapter.send('units needed', [
      { recipientId: 'r1', userId: 'u1' },
      { recipientId: 'r2', userId: null },
    ]);
    expect(outcomes).toEqual([{ recipientId: 'r1', delivered: true }, { recipientId: 'r2', delivered: false }]);
  });

  it('the in-app adapter never throws and handles an empty list', async () => {
    const adapter = createNotificationAdapter({ provider: 'inapp' });
    expect(await adapter.send('x', [])).toEqual([]);
  });

  it('fcm is not implemented: it fails loudly instead of pretending to deliver', async () => {
    const adapter = createNotificationAdapter({ provider: 'fcm', fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' } });
    expect(adapter.provider).toBe('fcm');
    await expect(adapter.send('x', [{ recipientId: 'r1', userId: 'u1' }])).rejects.toMatchObject({ status: 501, code: 'NOTIFICATION_PROVIDER_NOT_IMPLEMENTED' });
  });
});
