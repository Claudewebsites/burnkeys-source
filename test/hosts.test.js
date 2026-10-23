import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS } from '../src/hosts.js';

const fake = (routes) => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, method: opt.method, body: opt.body ? JSON.parse(opt.body) : undefined, auth: opt.headers.Authorization });
    const hit = routes.find(([m, re]) => m === opt.method && re.test(url));
    const [, , status = 200, json = {}] = hit ?? [];
    return { ok: status < 300, status: hit ? status : 404, json: async () => json };
  };
  return { calls, fetchImpl };
};

test('Netlify: sets the variable on the site, creates it when missing, then rebuilds', async () => {
  const { calls, fetchImpl } = fake([
    ['GET', /\/sites\/site1$/, 200, { account_id: 'acc1' }],
    ['PUT', /\/accounts\/acc1\/env\/API_KEY\?site_id=site1$/, 404],
    ['POST', /\/accounts\/acc1\/env\?site_id=site1$/, 201, []],
    ['POST', /\/sites\/site1\/builds$/, 200, {}],
  ]);
  const r = await HOSTS.netlify.set({ link: [{ siteId: 'site1' }], token: 'tok', names: ['API_KEY'], value: 'new-value', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls[2].body[0].key, 'API_KEY');
  assert.equal(calls.every((c) => c.auth === 'Bearer tok'), true);
});

test('Render: finds the service by name, sets the variable and deploys', async () => {
  const { calls, fetchImpl } = fake([
    ['GET', /\/services\?name=web/, 200, [{ service: { id: 'srv-1' } }]],
    ['PUT', /\/services\/srv-1\/env-vars\/API_KEY$/, 200, {}],
    ['POST', /\/services\/srv-1\/deploys$/, 201, {}],
  ]);
  const r = await HOSTS.render.set({ link: [{ name: 'web' }], token: 'tok', names: ['API_KEY'], value: 'v', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls[1].body.value, 'v');
});

test('Fly.io and Railway report a rejected token clearly', async () => {
  const { fetchImpl } = fake([['POST', /fly\.io|railway\.com/, 401]]);
  assert.match((await HOSTS.fly.set({ link: [{ app: 'a' }], token: 't', names: ['K'], value: 'v', fetchImpl })).error, /token rejected/);
  assert.match((await HOSTS.railway.set({ link: [{ projectId: 'p', environmentId: 'e' }], token: 't', names: ['K'], value: 'v', fetchImpl })).error, /token rejected/);
});
