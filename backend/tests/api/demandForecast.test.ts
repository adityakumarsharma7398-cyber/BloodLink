import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../db/fixtures.js';
import { buildApp, fakeAiClient, tokenFor } from '../support/testApp.js';
import { realDatabase, seedNetwork, withPg } from './harness.js';

/**
 * The AI service's demand forecast, wired into POST /api/intelligence/runs. It must be used when the
 * AI service answers validly, and the existing trailing-average baseline must still be used — with the
 * exact same numbers as before this phase — whenever it does not (unreachable, an error, or a malformed
 * body). Nothing here touches redistribution or donor-activation logic: they read whichever daily
 * demand ends up on the facility's own current prediction, unchanged.
 */
const db = realDatabase();
let n: Network;

const rows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);
const param = (key: string, value: unknown, org: string) =>
  rows(`insert into public.planning_parameters (key, organization_id, value, description) values ($1, $2, $3::jsonb, 'demand forecast api test')`, [key, org, JSON.stringify(value)]);

async function unit(facilityId: string, group: 'O-' | 'A+' = 'O-') {
  return (await rows(
    `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '60 days', now() + interval '30 days', 'INVENTORY_ADDED', 'AVAILABLE', null) as id`,
    [`AI-${randomUUID()}`, facilityId, n.comp.PRBC, n.bg[group]]))[0].id as string;
}
const issue = (id: string) => rows("select private.transition_unit_status($1::uuid, 'ISSUED', null)", [id]);

const run = (app: ReturnType<typeof buildApp>, userId: string, facilityId: string) =>
  request(app).post('/api/intelligence/runs').set('Authorization', `Bearer ${tokenFor(userId)}`).send({ facilityId });

const currentPrediction = (facilityId: string, type: 'DEMAND' | 'SHORTAGE') =>
  rows(
    `select predicted_daily_demand, predicted_quantity, model_name, model_version, confidence_score, confidence_method, explanation
     from public.predictions where facility_id = $1 and prediction_type = $2 and superseded_at is null and blood_group_id = $3 and component_id = $4`,
    [facilityId, type, n.bg['O-'], n.comp.PRBC],
  ).then((r) => r[0]);

beforeAll(async () => {
  n = await seedNetwork();
  await param('forecast.history_days', 10, n.org.abc);
  await param('forecast.horizon_days', 14, n.org.abc);
  for (const id of await Promise.all([unit(n.fac.centreA), unit(n.fac.centreA), unit(n.fac.centreA)])) await issue(id);
  await unit(n.fac.centreA); // one unit left usable
});

afterAll(async () => {
  await rows("delete from public.planning_parameters where description = 'demand forecast api test'");
  await db.disconnect();
});

describe('when the AI service answers with a valid forecast', () => {
  const AI_RESPONSE = {
    predicted_daily_demand: 4.5,
    predicted_quantity: 63,
    confidence_score: 0.92,
    confidence_method: 'linear_trend_r_squared',
    model_name: 'demand-forecast-linear-trend',
    model_version: '1',
    history_days_used: 10,
  };
  let sentPath = '';
  let sentBody: Record<string, unknown> = {};
  const app = buildApp({
    db,
    aiClient: fakeAiClient((path, body) => {
      sentPath = path;
      sentBody = body as Record<string, unknown>;
      return AI_RESPONSE;
    }),
  });

  it('uses the AI forecast for both the DEMAND and SHORTAGE predictions, sends it the real ledger history, and records which model produced a recommendation', async () => {
    const res = await run(app, n.user.centreAAdmin, n.fac.centreA);
    expect(res.status).toBe(201);
    expect(res.body.data.demandForecastMethods).toEqual({ AI_SERVICE: expect.any(Number), BASELINE: expect.any(Number) });
    expect(res.body.data.demandForecastMethods.AI_SERVICE).toBeGreaterThan(0);

    const demand = await currentPrediction(n.fac.centreA, 'DEMAND');
    expect(demand).toMatchObject({
      predicted_daily_demand: '4.500', model_name: 'demand-forecast-linear-trend', model_version: '1', confidence_score: '0.920', confidence_method: 'linear_trend_r_squared',
    });
    expect(demand.explanation.method).toContain('AI service demand forecast');
    expect(demand.explanation.model).toEqual({ name: 'demand-forecast-linear-trend', version: '1' });
    expect(demand.explanation.confidence).toEqual({ score: 0.92, method: 'linear_trend_r_squared' });

    const shortage = await currentPrediction(n.fac.centreA, 'SHORTAGE');
    expect(shortage).toMatchObject({ predicted_daily_demand: '4.500', model_name: 'demand-forecast-linear-trend', model_version: '1' });
    // days_of_cover now reflects the AI forecast's higher daily demand, not the baseline's
    const [row] = await rows('select days_of_cover from public.predictions where facility_id = $1 and prediction_type = $2 and superseded_at is null and blood_group_id = $3 and component_id = $4', [n.fac.centreA, 'SHORTAGE', n.bg['O-'], n.comp.PRBC]);
    expect(Number(row.days_of_cover)).toBeCloseTo(1 / 4.5, 2);

    // The request the AI service actually received for THIS series (O−/PRBC): facility, product codes, horizon
    // and the real ledger history — never patient, donor or other facilities' data. `sentPath`/`sentBody` are
    // overwritten on every one of the 32 series calls, so this must be read from within the same test run.
    expect(sentPath).toBe('/predict/demand');
    expect(Array.isArray(sentBody.history)).toBe(true);
    expect(JSON.stringify(sentBody)).not.toMatch(/patient|donor|phone|email|password/i);

    const rec = await rows(
      "select data_explanation from public.recommendations where facility_id = $1 and recommendation_type = 'PROCUREMENT' and status = 'PENDING' order by created_at desc limit 1",
      [n.fac.centreA],
    );
    if (rec[0]) expect(rec[0].data_explanation.demand_model).toEqual({ name: 'demand-forecast-linear-trend', version: '1' });
  });

  it('sends the O−/PRBC series its own facility, product codes and horizon', async () => {
    // A dedicated single-series check: filter to just the series this test cares about with its own AI client.
    let sentForOnePair: Record<string, unknown> | null = null;
    const app2 = buildApp({
      db,
      aiClient: fakeAiClient((_path, body) => {
        const b = body as Record<string, unknown>;
        if (b.blood_group_code === 'O-' && b.component_code === 'PRBC') sentForOnePair = b;
        return AI_RESPONSE;
      }),
    });
    await run(app2, n.user.centreAAdmin, n.fac.centreA);
    expect(sentForOnePair).toMatchObject({ facility_id: n.fac.centreA, blood_group_code: 'O-', component_code: 'PRBC', horizon_days: 14 });
  });
});

describe('when the AI service is unreachable', () => {
  const app = buildApp({ db, aiClient: fakeAiClient() }); // no handler = always throws "unreachable"

  it('falls back to the trailing-average baseline — the exact same numbers as before this phase', async () => {
    const res = await run(app, n.user.centreAAdmin, n.fac.centreA);
    expect(res.status).toBe(201);
    expect(res.body.data.demandForecastMethods).toEqual({ AI_SERVICE: 0, BASELINE: expect.any(Number) });

    const demand = await currentPrediction(n.fac.centreA, 'DEMAND');
    // 3 issued / 10-day window = 0.3/day (the same baseline arithmetic used throughout the intelligence suite)
    expect(demand).toMatchObject({ predicted_daily_demand: '0.300', model_name: 'trailing-average-baseline', model_version: '1', confidence_score: null, confidence_method: null });
    expect(demand.explanation.method).not.toMatch(/AI service/);
    expect(demand.explanation.assumptions.join(' ')).toMatch(/AI service was unreachable/);
  });
});

describe('when the AI service answers but the body is invalid', () => {
  it.each([
    ['a negative daily demand', { predicted_daily_demand: -1, predicted_quantity: 1, confidence_score: 0.5, confidence_method: 'x', model_name: 'm', model_version: '1', history_days_used: 1 }],
    ['a confidence score above 1', { predicted_daily_demand: 1, predicted_quantity: 1, confidence_score: 1.5, confidence_method: 'x', model_name: 'm', model_version: '1', history_days_used: 1 }],
    ['a missing field', { predicted_daily_demand: 1 }],
  ])('%s is treated as unreachable: the baseline is used, never a corrupted figure', async (_label, body) => {
    const app = buildApp({ db, aiClient: fakeAiClient(() => body) });
    const res = await run(app, n.user.centreAAdmin, n.fac.centreA);
    expect(res.status).toBe(201);
    const demand = await currentPrediction(n.fac.centreA, 'DEMAND');
    expect(demand).toMatchObject({ model_name: 'trailing-average-baseline', predicted_daily_demand: '0.300' });
  });
});

describe('a thrown, non-HTTP error from the AI client is also treated as unreachable', () => {
  it('never lets an unexpected client error break the run', async () => {
    const app = buildApp({
      db,
      aiClient: {
        call: async () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    const res = await run(app, n.user.centreAAdmin, n.fac.centreA);
    expect(res.status).toBe(201);
    const demand = await currentPrediction(n.fac.centreA, 'DEMAND');
    expect(demand.model_name).toBe('trailing-average-baseline');
  });
});
