import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../..');
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'generated' || name === 'dist') return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, ext) : ext.test(name) ? [full] : [];
  });
const read = (file: string) => readFileSync(file, 'utf8');
const rel = (file: string) => path.relative(repo, file).replaceAll('\\', '/');

describe('the frontend never receives server secrets or writes the database directly', () => {
  const frontend = files(path.join(repo, 'frontend/src'), /\.(ts|tsx)$/);

  it('does not reference any server-only variable', () => {
    expect(frontend.length).toBeGreaterThan(5);
    for (const file of frontend) {
      const source = read(file);
      for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'DIRECT_URL', 'AI_SERVICE_API_KEY', 'service_role']) {
        expect(source, `${rel(file)} mentions ${name}`).not.toContain(name);
      }
      expect(source, `${rel(file)} reads process.env`).not.toMatch(/process\.env/);
    }
  });

  it('only reads VITE_-prefixed variables', () => {
    for (const file of frontend) {
      for (const match of read(file).matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) expect(match[1], rel(file)).toMatch(/^VITE_/);
    }
  });

  it('never queries or writes database tables through the Supabase client', () => {
    for (const file of frontend) {
      expect(read(file), rel(file)).not.toMatch(/\.from\(\s*['"`]/);
      expect(read(file), rel(file)).not.toMatch(/\.rpc\(/);
    }
  });

  it('.env.example exposes only public values under the VITE_ prefix', () => {
    const example = read(path.join(repo, '.env.example'));
    const vite = [...example.matchAll(/^(VITE_[A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    expect(vite.sort()).toEqual(['VITE_API_BASE_URL', 'VITE_GOOGLE_MAPS_BROWSER_KEY', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL']);
  });

  it('the Vite config does not widen the exposed env prefix', () => {
    expect(read(path.join(repo, 'frontend/vite.config.ts'))).not.toMatch(/envPrefix/);
  });
});

describe('backend key boundaries', () => {
  const backend = files(path.join(repo, 'backend/src'), /\.ts$/);

  it('only config, the container and the admin-client module know the service-role key', () => {
    const allowed = new Set(['backend/src/config/env.ts', 'backend/src/services/supabase/supabaseAdmin.ts']);
    for (const file of backend) {
      if (allowed.has(rel(file))) continue;
      expect(read(file), rel(file)).not.toMatch(/serviceRoleKey|SERVICE_ROLE/);
    }
  });

  it('data access never goes through the Supabase admin client', () => {
    for (const file of backend) {
      if (rel(file) === 'backend/src/services/supabase/supabaseAdmin.ts') continue;
      expect(read(file), rel(file)).not.toMatch(/createSupabaseAdminClient|supabaseAdmin/);
    }
  });

  it('nothing in the backend reads process.env outside the configuration loader', () => {
    for (const file of backend) {
      if (rel(file) === 'backend/src/config/env.ts') continue;
      const source = read(file).replace(/process\.env\.npm_package_version/g, '');
      expect(source, rel(file)).not.toMatch(/process\.env/);
    }
  });

  it('the test .env guard exists: API tests never reference DB_VERIFY_URL or the root .env', () => {
    const api = files(path.join(repo, 'backend/tests/api'), /\.ts$/);
    expect(api.length).toBeGreaterThan(0);
    for (const file of api) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, rel(file)).not.toMatch(/process\.env|dotenv|DB_VERIFY_URL|loadRuntimeConfig|inject\('dbUrl'\)/);
    }
    expect(existsSync(path.join(repo, 'backend/vitest.api.config.ts'))).toBe(true);
  });
});
