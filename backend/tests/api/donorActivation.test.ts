import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDemoRules, type Network } from '../db/fixtures.js';
import { buildApp, testConfig, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork, withPg } from './harness.js';

/**
 * Centre A (ABC organization) is short of O− PRBC. Several test donors sit at various distances around it, with
 * different consent/availability/history so each targeting rule can be exercised on its own.
 */
const db = realDatabase();
const demoApp = buildApp({ db, config: testConfig({ ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }) });
let n: Network;
let manager: string; // INVENTORY_MANAGER at Centre A: may run, may not decide/notify/cancel
let staff: string; // BLOOD_BANK_STAFF at Centre A: may read only
let superAdmin: string;
let donorNear: string; // consenting, ACTIVE, AVAILABLE, close, never donated
let donorFar: string; // consenting, eligible, but outside the radius
let donorNoConsent: string;
let donorRecentlyDonated: string;
let donorInactive: string;
let donorNoLocation: string;
let donorWithAccount: { userId: string; donorId: string };

const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (path: string, userId?: string) => (userId ? request(demoApp).get(path).set(as(userId)) : request(demoApp).get(path));
const post = (path: string, body: unknown, userId?: string) =>
  userId ? request(demoApp).post(path).set(as(userId)).send(body as object) : request(demoApp).post(path).send(body as object);
const rows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);

async function unit(facilityId: string, count: number, group: 'O-' = 'O-') {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await rows(
      `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '60 days', now() + interval '30 days', 'INVENTORY_ADDED', 'AVAILABLE', null) as id`,
      [`DA-${randomUUID()}`, facilityId, n.comp.PRBC, n.bg[group]]))[0].id);
  }
  return ids;
}
const issue = (id: string) => rows("select private.transition_unit_status($1::uuid, 'ISSUED', null)", [id]);
const param = (key: string, value: unknown, org = n.org.abc) =>
  rows(`insert into public.planning_parameters (key, organization_id, value, description) values ($1, $2, $3::jsonb, 'donor activation api test')`, [key, org, JSON.stringify(value)]);

async function donor(
  name: string,
  group: 'O-' | 'A+',
  over: { consent?: boolean; status?: string; availability?: string; lastDonationDaysAgo?: number | null; lat?: number | null; lon?: number | null; userId?: string } = {},
) {
  const id = randomUUID();
  await rows(
    `insert into public.donors (id, user_id, full_name, blood_group_id, phone, email, latitude, longitude, availability_status, status, consent_to_contact, last_donation_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, over.userId ?? null, name, n.bg[group], '9999999999', `${name.toLowerCase()}@test.bloodlink.invalid`,
      over.lat === undefined ? 26.85 : over.lat, over.lon === undefined ? 80.95 : over.lon,
      over.availability ?? 'AVAILABLE', over.status ?? 'ACTIVE', over.consent ?? true,
      over.lastDonationDaysAgo === undefined ? null : over.lastDonationDaysAgo === null ? null : new Date(Date.now() - over.lastDonationDaysAgo * 86_400_000).toISOString().slice(0, 10)]);
  return id;
}

const runActivation = (userId = n.user.centreAAdmin, facilityId = n.fac.centreA) => post('/api/donor-activations/runs', { facilityId }, userId);
const recs = async (status = 'PENDING', userId = n.user.centreAAdmin) =>
  (await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreA}&type=DONOR_ACTIVATION&status=${status}`, userId)).body;
const pendingRec = async () => (await recs()).data[0];
const decide = (recId: string, body: unknown, userId = n.user.centreAAdmin) => post(`/api/intelligence/recommendations/${recId}/decision`, body, userId);
/** A fresh recommendation from a clean run (re-running expires the previous pending one). */
async function freshRecommendation() {
  const res = await runActivation();
  expect(res.status).toBe(201);
  return pendingRec();
}

beforeAll(async () => {
  n = await seedNetwork();
  manager = await createUser('DaManager', n.org.abc, n.fac.centreA);
  await grantRole(manager, 'INVENTORY_MANAGER', n.org.abc, n.fac.centreA);
  staff = await createUser('DaStaff', n.org.abc, n.fac.centreA);
  await grantRole(staff, 'BLOOD_BANK_STAFF', n.org.abc, n.fac.centreA);
  superAdmin = await createUser('DaSuper', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);

  await withPg((c) => addDemoRules(c, n, ['O-']));
  await param('forecast.history_days', 10);
  await param('forecast.horizon_days', 14);
  await param('coverage.target_days', 30);
  await param('coverage.risk_bands', { criticalBelowDays: 2, highBelowDays: 5, mediumBelowDays: 10 });

  // Centre A O− PRBC: 1 usable, 3 issued in the window → demand 0.3/day, deficit ceil(30×0.3 − 1) = 8.
  await unit(n.fac.centreA, 1);
  for (const id of await unit(n.fac.centreA, 3)) await issue(id);
  expect((await post('/api/intelligence/runs', { facilityId: n.fac.centreA }, n.user.centreAAdmin)).status).toBe(201);

  donorNear = await donor('Near', 'O-', { lat: 26.85, lon: 80.95 });
  donorFar = await donor('Far', 'O-', { lat: 27.5, lon: 81.5 }); // ~90km away
  donorNoConsent = await donor('NoConsent', 'O-', { consent: false });
  donorRecentlyDonated = await donor('Recent', 'O-', { lastDonationDaysAgo: 10 });
  donorInactive = await donor('Inactive', 'O-', { status: 'INACTIVE' });
  donorNoLocation = await donor('NoLocation', 'O-', { lat: null, lon: null });
  const accountUserId = await createUser('DonorWithAccount', null, null);
  await grantRole(accountUserId, 'DONOR', null, null);
  const donorId = await donor('WithAccount', 'O-', { userId: accountUserId, lat: 26.80, lon: 80.90 }); // within radius, but farther than donorNear
  donorWithAccount = { userId: accountUserId, donorId };
});

afterAll(async () => {
  await rows("delete from public.planning_parameters where description = 'donor activation api test'");
  await db.disconnect();
});

describe('access control', () => {
  it('requires authentication on every endpoint', async () => {
    expect((await post('/api/donor-activations/runs', { facilityId: n.fac.centreA })).status).toBe(401);
    expect((await get('/api/donor-activations')).status).toBe(401);
    expect((await get('/api/donor-activations/mine')).status).toBe(401);
    expect((await post(`/api/donor-activations/recipients/${randomUUID()}/respond`, { response: 'WILLING' })).status).toBe(401);
  });

  it('roles without inventory access are forbidden on the staff-facing endpoints', async () => {
    for (const userId of [n.user.drSharma, n.user.publicUser, n.user.donorUser, n.user.sunriseStaff, superAdmin]) {
      expect((await runActivation(userId)).status, userId).toBe(403);
      expect((await get('/api/donor-activations', userId)).status, userId).toBe(403);
    }
  });

  it('read-only staff can read but not run; managers can run but not notify, cancel or decide', async () => {
    expect((await get('/api/donor-activations', staff)).status).toBe(200);
    expect((await runActivation(staff)).status).toBe(403);
    expect((await runActivation(manager)).status).toBe(201);
    expect((await post(`/api/donor-activations/${randomUUID()}/notify`, {}, manager)).status).toBe(403);
    expect((await post(`/api/donor-activations/${randomUUID()}/cancel`, {}, manager)).status).toBe(403);
    expect((await decide(randomUUID(), { decision: 'APPROVE' }, manager)).status).toBe(403);
  });

  it('another organization cannot run against this facility (404), and a facility without stock is 422', async () => {
    expect((await runActivation(n.user.centreBAdmin, n.fac.centreA)).status).toBe(404);
    expect((await runActivation(n.user.abcOrgAdmin, n.fac.abcHospital)).status).toBe(422);
  });

  it('only DONOR uses the self-service endpoints', async () => {
    for (const userId of [n.user.centreAAdmin, n.user.drSharma, superAdmin]) {
      expect((await get('/api/donor-activations/mine', userId)).status).toBe(403);
      expect((await post(`/api/donor-activations/recipients/${randomUUID()}/respond`, { response: 'WILLING' }, userId)).status).toBe(403);
    }
  });
});

describe('identifying when donor activation is appropriate', () => {
  it('needs a current shortage: nothing else configured yet means no recommendation, with a reason', async () => {
    // Before donor.search_radius_km / donor.min_interval_days are configured.
    const res = await runActivation();
    expect(res.status).toBe(201);
    expect(res.body.data.donorActivationRecommendations).toEqual([]);
    expect(res.body.data.notRecommended.some((r: any) => r.reason === 'RADIUS_NOT_CONFIGURED')).toBe(true);
  });

  it('needs donor.min_interval_days too', async () => {
    await param('donor.search_radius_km', 20);
    const res = await runActivation();
    expect(res.body.data.notRecommended.some((r: any) => r.reason === 'MIN_INTERVAL_NOT_CONFIGURED')).toBe(true);
  });

  it('creates a PENDING DONOR_ACTIVATION recommendation once configured, with counts only — never donor identities', async () => {
    await param('donor.min_interval_days', 90);
    const res = await runActivation();
    expect(res.status).toBe(201);
    expect(res.body.data.donorActivationRecommendations).toEqual([
      { id: expect.any(String), bloodGroup: 'O-', component: 'PRBC', unitsNeeded: 8, targetDonorCount: expect.any(Number), eligibleDonorCount: expect.any(Number), priority: expect.any(String) },
    ]);
    const rec = await pendingRec();
    expect(rec).toMatchObject({ type: 'DONOR_ACTIVATION', status: 'PENDING', source: 'SYSTEM_RULE', facilityId: n.fac.centreA, decidedBy: null });
    expect(rec.payload).toEqual({
      facility_id: n.fac.centreA, blood_group_id: n.bg['O-'], component_id: n.comp.PRBC, units_needed: 8,
      eligible_donor_count: expect.any(Number), radius_km: 20, quantity: expect.any(Number),
    });
    expect(rec.explanation.action).toMatch(/never releases blood/);
    // eligible count = near + recently-donated? no (excluded) + inactive? no + no-consent? no + with-account: near, far excluded by radius
    expect(rec.payload.eligible_donor_count).toBe(2); // donorNear (0 km) + donorWithAccount (~7 km) are within 20km, consenting, ACTIVE, AVAILABLE, no recent donation
    expect(JSON.stringify(rec)).not.toMatch(/Near|Far|NoConsent|Recent|Inactive|WithAccount|9999999999|@test\.bloodlink/);
  });

  it('re-running expires the previous pending recommendation (one current per series)', async () => {
    const before = await pendingRec();
    await runActivation();
    expect((await recs('EXPIRED')).data.map((r: any) => r.id)).toContain(before.id);
    expect((await recs()).data).toHaveLength(1);
  });

  it('leaves out a donor group with no usable compatibility rule (never invents one)', async () => {
    // A+ has no configured rule at all in this test database, so even if it were short it could never be targeted.
    const rows_ = await recs('PENDING');
    expect(rows_.data.every((r: any) => r.payload.blood_group_id === n.bg['O-'])).toBe(true);
  });

  it('audits the run with counts only, and changes no donor, unit or ledger row', async () => {
    const snapshot = () => rows(
      `select (select count(*) from public.donors)::int d, (select count(*) from public.inventory_units)::int u,
              (select count(*) from public.transactions)::int t, (select count(*) from public.donor_activations)::int da`);
    const before = await snapshot();
    const res = await runActivation();
    expect(await snapshot()).toEqual(before);
    const [entry] = await rows("select user_id, organization_id, facility_id, new_value from public.audit_logs where action = 'donor_activation.recommend' and facility_id = $1 order by occurred_at desc limit 1", [n.fac.centreA]);
    expect(entry).toMatchObject({ user_id: n.user.centreAAdmin, organization_id: n.org.abc, facility_id: n.fac.centreA });
    expect(entry.new_value).toMatchObject({ recommendations_created: 1 });
    void res;
  });
});

describe('approving activates and selects/records donors — never blood release', () => {
  it('cannot raise the donor count above the recommendation (422)', async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: rec.payload.quantity + 5, note: 'more' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('QUANTITY_ABOVE_RECOMMENDATION');
    expect(await rows('select id from public.donor_activations where recommendation_id = $1', [rec.id])).toHaveLength(0);
  });

  it('approve: creates an ACTIVE donor_activations row and recipients for the eligible donors, decided by a human', async () => {
    const ledgerCount = () => rows(
      "select count(*)::int n from public.transactions where facility_id = $1 and transaction_type in ('INVENTORY_RESERVED', 'INVENTORY_DISPATCHED', 'INVENTORY_ISSUED')",
      [n.fac.centreA]).then((r) => r[0].n);
    const before = await ledgerCount();
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'APPROVE' }, n.user.abcOrgAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', decidedBy: n.user.abcOrgAdmin, donorActivationId: expect.any(String) });

    const [activation] = await rows('select * from public.donor_activations where id = $1', [res.body.data.donorActivationId]);
    expect(activation).toMatchObject({
      organization_id: n.org.abc, facility_id: n.fac.centreA, blood_group_id: n.bg['O-'], component_id: n.comp.PRBC,
      units_needed: 8, status: 'ACTIVE', activated_by: n.user.abcOrgAdmin, recommendation_id: rec.id,
    });
    expect(Number(activation.radius_km)).toBe(20);
    expect(activation.target_donor_count).toBeGreaterThan(0);
    expect(activation.donor_message).not.toMatch(/Near|Far|9999999999/);

    const recipients = await rows('select donor_id, distance_km, notification_status, response from public.donor_activation_recipients where activation_id = $1', [activation.id]);
    expect(recipients.length).toBe(activation.target_donor_count);
    expect(new Set(recipients.map((r) => r.donor_id)).size).toBe(recipients.length); // no donor duplicated
    for (const r of recipients) expect(r).toMatchObject({ notification_status: 'PENDING', response: 'NO_RESPONSE' });
    // never targets a non-consenting, recently-donated, inactive, no-location or out-of-radius donor
    expect(recipients.map((r) => r.donor_id)).not.toEqual(expect.arrayContaining([donorNoConsent, donorRecentlyDonated, donorInactive, donorNoLocation, donorFar]));

    // the audit trail carries counts and radius only — never which donors were targeted
    const [audit] = await rows("select new_value from public.audit_logs where action = 'donor_activation.create' and entity_id = $1", [activation.id]);
    expect(audit.new_value).toEqual({ blood_group_id: n.bg['O-'], component_id: n.comp.PRBC, units_needed: 8, radius_km: 20, target_donor_count: activation.target_donor_count, recipients_created: recipients.length });
    expect(JSON.stringify(audit)).not.toMatch(/Near|WithAccount|9999999999|@test\.bloodlink/);

    // no unit at this facility was reserved, dispatched or issued by the activation — nothing is released
    expect(await ledgerCount()).toBe(before);

    await post(`/api/donor-activations/${activation.id}/cancel`, {}, n.user.centreAAdmin); // restore eligibility for the tests that follow
  });

  it('modify: lowers the donor count and targets fewer, nearest first', async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 1, note: 'start small' });
    expect(res.status).toBe(200);
    const recipients = await rows('select donor_id from public.donor_activation_recipients where activation_id = $1', [res.body.data.donorActivationId]);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].donor_id).toBe(donorNear); // nearest of the two eligible donors
    expect(await rows('select id from public.donor_activations where id = $1', [res.body.data.donorActivationId])).toHaveLength(1);

    await post(`/api/donor-activations/${res.body.data.donorActivationId}/cancel`, {}, n.user.centreAAdmin); // restore eligibility for the tests that follow
  });

  it('reject: creates no activation', async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'REJECT', note: 'handled by procurement instead' });
    expect(res.body.data).toMatchObject({ status: 'REJECTED', donorActivationId: null });
    expect(await rows('select id from public.donor_activations where recommendation_id = $1', [rec.id])).toHaveLength(0);
  });

  it('the same donor is never targeted twice while an activation is still active (no duplicate activation of one donor)', async () => {
    const first = await freshRecommendation();
    const firstDecision = await decide(first.id, { decision: 'MODIFY', modifiedQuantity: 1, note: 'first wave' });
    const firstRecipients = await rows('select donor_id from public.donor_activation_recipients where activation_id = $1', [firstDecision.body.data.donorActivationId]);

    const second = await freshRecommendation();
    expect(second.payload.eligible_donor_count).toBe(1); // the first wave's donor (donorNear) is now excluded; only donorWithAccount remains
    const secondDecision = await decide(second.id, { decision: 'APPROVE' });
    const secondRecipients = await rows('select donor_id from public.donor_activation_recipients where activation_id = $1', [secondDecision.body.data.donorActivationId]);
    expect(secondRecipients.map((r) => r.donor_id)).not.toEqual(expect.arrayContaining(firstRecipients.map((r) => r.donor_id)));

    await post(`/api/donor-activations/${firstDecision.body.data.donorActivationId}/cancel`, {}, n.user.centreAAdmin); // restore eligibility for the tests that follow
    await post(`/api/donor-activations/${secondDecision.body.data.donorActivationId}/cancel`, {}, n.user.centreAAdmin);
  });

  it('an expired recommendation cannot be decided', async () => {
    const rec = await freshRecommendation();
    await rows("update public.recommendations set valid_until = now() - interval '1 minute' where id = $1", [rec.id]);
    const res = await decide(rec.id, { decision: 'APPROVE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECOMMENDATION_EXPIRED');
  });

  it('another organization cannot decide it (404); a decider role elsewhere cannot either', async () => {
    const rec = await freshRecommendation();
    expect((await decide(rec.id, { decision: 'APPROVE' }, n.user.centreBAdmin)).status).toBe(404);
  });
});

describe('managing an active activation: notify, list, get, cancel', () => {
  let activationId: string;

  beforeAll(async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'APPROVE' });
    activationId = res.body.data.donorActivationId;
  });

  it('GET shows counts and no donor identity until a donor responds WILLING', async () => {
    const res = await get(`/api/donor-activations/${activationId}`, n.user.centreAAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: activationId, facilityId: n.fac.centreA, bloodGroup: 'O-', component: 'PRBC', status: 'ACTIVE' });
    expect(res.body.data.recipients.byResponse).toMatchObject({ NO_RESPONSE: expect.any(Number), WILLING: 0, DECLINED: 0 });
    expect(res.body.data.willingDonors).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/Near|WithAccount|9999999999|@test\.bloodlink/);
    expect((await get(`/api/donor-activations/${activationId}`, n.user.centreBAdmin)).status).toBe(404);
    expect((await get('/api/donor-activations?pageSize=100', n.user.centreAAdmin)).body.data.map((a: any) => a.id)).toContain(activationId);
  });

  it('notify: only the donor with a BloodLink account is delivered; others are recorded as failed, none re-notified twice', async () => {
    const res = await post(`/api/donor-activations/${activationId}/notify`, {}, n.user.centreAAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.notified).toBeGreaterThan(0);
    expect(res.body.data.delivered).toBeGreaterThanOrEqual(1);
    const statuses = await rows('select notification_status, donor_id from public.donor_activation_recipients where activation_id = $1', [activationId]);
    for (const s of statuses) expect(['SENT', 'FAILED']).toContain(s.notification_status);
    const withAccountRow = statuses.find((s) => s.donor_id === donorWithAccount.donorId);
    if (withAccountRow) expect(withAccountRow.notification_status).toBe('SENT');
    const again = await post(`/api/donor-activations/${activationId}/notify`, {}, n.user.centreAAdmin);
    expect(again.body.data).toEqual({ notified: 0, delivered: 0, failed: 0 }); // already SENT/FAILED, nothing left PENDING
    const [audit] = await rows("select new_value from public.audit_logs where action = 'donor_activation.notify' and entity_id = $1 order by occurred_at desc limit 1", [activationId]);
    expect(audit.new_value).toMatchObject({ provider: 'inapp' });
  });

  it('only BLOOD_BANK_ADMIN/ORG_ADMIN can notify or cancel; another organization gets 404', async () => {
    expect((await post(`/api/donor-activations/${activationId}/notify`, {}, staff)).status).toBe(403);
    expect((await post(`/api/donor-activations/${activationId}/notify`, {}, n.user.centreBAdmin)).status).toBe(404);
    expect((await post(`/api/donor-activations/${activationId}/cancel`, {}, n.user.centreBAdmin)).status).toBe(404);
  });

  it('cancel: stops the activation and cannot be repeated', async () => {
    const res = await post(`/api/donor-activations/${activationId}/cancel`, {}, n.user.centreAAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    const again = await post(`/api/donor-activations/${activationId}/cancel`, {}, n.user.centreAAdmin);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ACTIVATION_NOT_ACTIVE');
    expect((await post(`/api/donor-activations/${activationId}/notify`, {}, n.user.centreAAdmin)).status).toBe(409);
    const [audit] = await rows("select old_value, new_value from public.audit_logs where action = 'donor_activation.cancel' and entity_id = $1", [activationId]);
    expect(audit).toEqual({ old_value: { status: 'ACTIVE' }, new_value: { status: 'CANCELLED' } });
  });
});

describe('the donor’s own response — privacy, one response only', () => {
  let activationId: string;
  let myRecipientId: string;

  beforeAll(async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'APPROVE' });
    activationId = res.body.data.donorActivationId;
    const row = await rows('select id from public.donor_activation_recipients where activation_id = $1 and donor_id = $2', [activationId, donorWithAccount.donorId]);
    myRecipientId = row[0]?.id;
  });

  it('a donor sees only their own activations, with no other donor’s data', async () => {
    const res = await get('/api/donor-activations/mine', donorWithAccount.userId);
    expect(res.status).toBe(200);
    const mine = res.body.data.find((a: any) => a.activation.id === activationId);
    expect(mine).toMatchObject({
      recipientId: expect.any(String), response: 'NO_RESPONSE', notificationStatus: expect.any(String),
      activation: { id: activationId, status: 'ACTIVE', bloodGroup: 'O-', component: 'PRBC', donorMessage: expect.any(String) },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/9999999999|@test\.bloodlink|Near|WithAccount/);
    // an unrelated donor sees an empty list, never someone else's recipient rows
    expect((await get('/api/donor-activations/mine', n.user.donorUser)).body.data).toEqual([]);
  });

  it('responding for someone else’s recipient row is refused (404): a donor can only affect their own row', async () => {
    const otherRow = await rows('select id from public.donor_activation_recipients where activation_id = $1 and donor_id != $2 limit 1', [activationId, donorWithAccount.donorId]);
    if (otherRow[0]) {
      expect((await post(`/api/donor-activations/recipients/${otherRow[0].id}/respond`, { response: 'WILLING' }, donorWithAccount.userId)).status).toBe(404);
    }
    expect((await post(`/api/donor-activations/recipients/${randomUUID()}/respond`, { response: 'WILLING' }, donorWithAccount.userId)).status).toBe(404);
  });

  it('responds WILLING exactly once; a second response is refused and the first stands', async () => {
    expect(myRecipientId).toBeTruthy();
    const res = await post(`/api/donor-activations/recipients/${myRecipientId}/respond`, { response: 'WILLING' }, donorWithAccount.userId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ recipientId: myRecipientId, response: 'WILLING' });
    const again = await post(`/api/donor-activations/recipients/${myRecipientId}/respond`, { response: 'DECLINED' }, donorWithAccount.userId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RESPONSE_ALREADY_RECORDED');
    expect((await rows('select response from public.donor_activation_recipients where id = $1', [myRecipientId]))[0].response).toBe('WILLING');
    const auditRows = await rows("select organization_id, old_value, new_value from public.audit_logs where action = 'donor_activation.recipient_respond' and entity_id = $1", [myRecipientId]);
    expect(auditRows).toEqual([{ organization_id: n.org.abc, old_value: { response: 'NO_RESPONSE' }, new_value: { response: 'WILLING' } }]);
  });

  it('once WILLING, blood-centre staff can now see that one donor’s minimum contact details — never the others', async () => {
    const res = await get(`/api/donor-activations/${activationId}`, n.user.centreAAdmin);
    expect(res.body.data.willingDonors).toEqual([
      { recipientId: myRecipientId, distanceKm: expect.any(Number), respondedAt: expect.any(String), donor: { id: donorWithAccount.donorId, fullName: 'WithAccount', phone: '9999999999', email: 'withaccount@test.bloodlink.invalid' } },
    ]);
    // date of birth, address and other profile fields are never exposed even for a WILLING donor
    expect(Object.keys(res.body.data.willingDonors[0].donor).sort()).toEqual(['email', 'fullName', 'id', 'phone'].sort());
  });

  it('rejects an invalid response value and requires a body', async () => {
    expect((await post(`/api/donor-activations/recipients/${randomUUID()}/respond`, { response: 'MAYBE' }, donorWithAccount.userId)).status).toBe(400);
    expect((await post(`/api/donor-activations/recipients/${randomUUID()}/respond`, {}, donorWithAccount.userId)).status).toBe(400);
  });
});
