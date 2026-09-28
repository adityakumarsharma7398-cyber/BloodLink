import type { AppConfig } from '../../config/env.js';
import { HttpError } from '../../utils/httpError.js';

export interface NotificationTarget {
  readonly recipientId: string;
  /** The donor's own user id, if the donor has a BloodLink account (donors may exist without one). */
  readonly userId: string | null;
}

export interface NotificationOutcome {
  readonly recipientId: string;
  readonly delivered: boolean;
}

export interface NotificationAdapter {
  readonly provider: 'inapp' | 'fcm';
  send(message: string, targets: readonly NotificationTarget[]): Promise<NotificationOutcome[]>;
}

/**
 * The "inapp" adapter does not call out anywhere: `donor_activation_recipients` is already in the Realtime
 * publication (migration 006, §10.4) and RLS lets a donor read their own row, so marking a row SENT is itself the
 * delivery — the donor's own client is notified by Postgres Changes. A donor with no BloodLink account (no
 * `user_id`) cannot receive an in-app notification; that row is reported as not delivered.
 */
function createInAppAdapter(): NotificationAdapter {
  return {
    provider: 'inapp',
    async send(_message, targets) {
      return targets.map((target) => ({ recipientId: target.recipientId, delivered: target.userId !== null }));
    },
  };
}

/**
 * FCM is configured (env.ts requires the service-account fields) but push delivery is an external integration
 * this phase does not add. Calling it fails loudly instead of pretending to send a push notification.
 */
function createFcmAdapter(): NotificationAdapter {
  return {
    provider: 'fcm',
    async send() {
      throw new HttpError(501, 'FCM push delivery is not implemented yet', 'NOTIFICATION_PROVIDER_NOT_IMPLEMENTED');
    },
  };
}

export function createNotificationAdapter(config: AppConfig['adapters']['notifications']): NotificationAdapter {
  return config.provider === 'fcm' ? createFcmAdapter() : createInAppAdapter();
}
