import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from '../src/config.js';
import { DEFAULT_MCP_AUTH } from '../src/db/schema.js';

/**
 * The one-click templates under `deploy/` put the port on the public internet, which the compose files
 * deliberately do not (ADR-0065). What keeps such an instance closed is authentication, so this file
 * is the gate on the property the templates must never lose: nothing in them opens a project, and the
 * things that keep the first-run page and the stored credentials safe are required (ADR-0065), and so is leaving `TRUST_PROXY` at its safe default (ADR-0060).
 *
 * The checks are structural. They cannot prove a platform accepts a file; they prove the file says
 * what `docs/deployment.md` promises.
 */
const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@db.internal:5432/contextator',
  SECRET_KEY: 'x'.repeat(40),
  SETUP_CODE: 'x'.repeat(10),
};
const railwayRaw = read('deploy/railway/railway.json');
const renderRaw = read('deploy/render/render.yaml');
const flyRaw = read('deploy/fly/fly.toml');

interface RenderEnvVar {
  key: string;
  value?: string;
  generateValue?: boolean;
  sync?: boolean;
  fromDatabase?: { name: string; property: string };
}
interface RenderBlueprint {
  databases: { name: string; postgresMajorVersion?: string }[];
  services: {
    type: string;
    image?: { url: string };
    healthCheckPath?: string;
    disk?: { mountPath: string };
    envVars: RenderEnvVar[];
  }[];
}
const render = parseYaml(renderRaw) as RenderBlueprint;
const renderService = render.services[0];
if (!renderService) throw new Error('deploy/render/render.yaml defines no service');

/** Names that would switch authentication off or hand out access by default, in any spelling. */
const OPEN_AUTH_MARKERS = /mcp[_-]?auth|auth[_-]?(disabled|off|none)|(disable|no|skip)[_-]?auth|allow[_-]?anonymous|anonymous[_-]?access|insecure/i;

/** Every environment variable a template sets, by file. */
function envKeys(): Record<string, string[]> {
  const flyEnv = /^\[env\]\n([\s\S]*?)(?=^\[)/m.exec(flyRaw)?.[1] ?? '';
  return {
    render: renderService?.envVars.map((v) => v.key) ?? [],
    fly: [...flyEnv.matchAll(/^\s*([A-Z_]+) = /gm)].map((m) => m[1] as string),
  };
}

describe('deploy templates never open authentication', () => {
  it('the default they rely on is still token', () => {
    expect(DEFAULT_MCP_AUTH).toBe('token');
  });

  it.each([
    ['railway.json', railwayRaw],
    ['render.yaml', renderRaw],
    ['fly.toml', flyRaw],
  ])('%s mentions no setting that opens a project', (_name, raw) => {
    // Comments are text too; a comment that names such a setting is how it gets copied in by hand.
    expect(raw).not.toMatch(OPEN_AUTH_MARKERS);
  });

  it('no template sets a variable the server does not read, so none can be a silent switch', () => {
    const config = read('src/config.ts');
    for (const [file, keys] of Object.entries(envKeys())) {
      expect(keys.length, `${file}: found no environment variables`).toBeGreaterThan(0);
      for (const key of keys) expect(config, `${file} sets ${key}, which src/config.ts does not read`).toMatch(new RegExp(`^\\s+${key}:`, 'm'));
    }
  });

  it('no template carries a secret in clear', () => {
    const values = renderService.envVars.filter((v) => ['SECRET_KEY', 'SETUP_CODE', 'ADMIN_TOKEN', 'DATABASE_URL'].includes(v.key));
    for (const v of values) expect(v.value, `render.yaml puts a literal in ${v.key}`).toBeUndefined();
    expect(flyRaw).not.toMatch(/^\s*(SECRET_KEY|SETUP_CODE|ADMIN_TOKEN|DATABASE_URL)\s*=/m);
    expect(flyRaw).not.toMatch(/postgres(ql)?:\/\/[^\s'"$]+:[^\s'"$]+@/);
    expect(railwayRaw).not.toMatch(/SECRET_KEY|SETUP_CODE|ADMIN_TOKEN|DATABASE_URL|postgres(ql)?:\/\//);
  });
});

describe('deploy templates keep the proxy-trust default (ADR-0060)', () => {
  // `1`/`true` trusts whoever wrote X-Forwarded-For, which hands every caller its own rate-limit key.
  // A named proxy address or CIDR would be fine; "everything" never is.
  it.each([
    ['render.yaml', renderRaw],
    ['fly.toml', flyRaw],
    ['railway.json', railwayRaw],
  ])('%s does not set TRUST_PROXY to a trust-everything value', (_name, raw) => {
    expect(raw).not.toMatch(/TRUST_PROXY["']?\s*[:=]?\s*(-\s*)?(value:\s*)?["']?(1|true)["']?\s*$/im);
    expect(raw).not.toMatch(/key:\s*TRUST_PROXY\s*\n\s*value:\s*["']?(1|true)["']?/i);
  });

  it('a Render env that sets TRUST_PROXY at all names a proxy rather than trusting everything', () => {
    const value = renderService.envVars.find((v) => v.key === 'TRUST_PROXY')?.value;
    if (value !== undefined) expect(loadConfig({ ...baseEnv, TRUST_PROXY: value }).TRUST_PROXY).not.toBe(true);
  });

  it('both templates that set cookies say they are HTTPS only, since the proxy is not trusted for the scheme', () => {
    expect(renderService.envVars.find((v) => v.key === 'AUTH_COOKIE_SECURE')?.value).toBe('1');
    expect(flyRaw).toMatch(/^\s*AUTH_COOKIE_SECURE = "1"$/m);
  });

  it('docs/deployment.md states what the shared rate-limit key costs, and that OAuth needs PUBLIC_BASE_URL', () => {
    const docs = read('docs/deployment.md');
    expect(docs).toMatch(/setup page share one budget/);
    expect(docs).toMatch(/hold that budget empty/);
    expect(docs).toMatch(/resets the shared budget/);
    expect(docs).toMatch(/OAuth connectors[^.]*refused with `invalid_target`/);
    // The URL has to be set before a connector is attached, so it comes before the project step.
    expect(docs.indexOf('1. Make sure `PUBLIC_BASE_URL`')).toBeLessThan(docs.indexOf('3. Create a project.'));
  });

  it('docs/deployment.md does not tell anyone to set TRUST_PROXY to 1', () => {
    expect(read('docs/deployment.md')).not.toMatch(/`TRUST_PROXY`\s*=\s*`(1|true)`/);
  });
});

describe('render.yaml', () => {
  const byKey = (key: string) => renderService.envVars.find((v) => v.key === key);

  it('runs the slim image against a Render PostgreSQL 16', () => {
    expect(renderService.type).toBe('web');
    expect(renderService.image?.url).toMatch(/^docker\.io\/contextator\/contextator:[\w.]+-slim$/);
    expect(render.databases).toHaveLength(1);
    expect(render.databases[0]?.postgresMajorVersion).toBe('16');
    expect(byKey('DATABASE_URL')?.fromDatabase).toEqual({ name: render.databases[0]?.name, property: 'connectionString' });
  });

  it('generates SECRET_KEY and SETUP_CODE instead of leaving them out', () => {
    expect(byKey('SECRET_KEY')?.generateValue).toBe(true);
    expect(byKey('SETUP_CODE')?.generateValue).toBe(true);
  });

  it('asks for PUBLIC_BASE_URL without baking one in, and keeps a disk for /data and the model cache', () => {
    expect(byKey('PUBLIC_BASE_URL')).toMatchObject({ sync: false });
    expect(byKey('PUBLIC_BASE_URL')?.value).toBeUndefined();
    expect(renderService.disk?.mountPath).toBe('/data');
    expect(byKey('DATA_DIR')?.value).toBe('/data');
    expect(byKey('MODEL_CACHE_DIR')?.value?.startsWith('/data/')).toBe(true);
    expect(renderService.healthCheckPath).toBe('/api/health');
  });

  it('configures a server that starts once the generated secrets are filled in', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const v of renderService.envVars) {
      if (v.value !== undefined) env[v.key] = v.value;
      if (v.generateValue) env[v.key] = 'x'.repeat(40);
    }
    env.DATABASE_URL = 'postgres://u:p@db.internal:5432/contextator';
    const config = loadConfig(env);
    expect(config.SETUP_CODE).toBeDefined();
    expect(config.SECRET_KEY).toBeDefined();
    expect(config.DATA_DIR).toBe('/data');
  });
});

describe('fly.toml', () => {
  it('runs the slim image and routes the app port with TLS forced', () => {
    expect(flyRaw).toMatch(/^\s*image = "contextator\/contextator:[\w.]+-slim"$/m);
    expect(flyRaw).toMatch(/^\s*internal_port = 3444$/m);
    expect(flyRaw).toMatch(/^\s*force_https = true$/m);
  });

  it('mounts a volume at /data and caches the model on it', () => {
    expect(flyRaw).toMatch(/^\[mounts\]\n\s+source = "\w+"\n\s+destination = "\/data"$/m);
    expect(flyRaw).toMatch(/^\s*MODEL_CACHE_DIR = "\/data\/models"$/m);
  });

  it('checks /api/health with a grace period long enough for the model download', () => {
    expect(flyRaw).toMatch(/path = "\/api\/health"/);
    const grace = /grace_period = "(\d+)s"/.exec(flyRaw)?.[1];
    expect(Number(grace)).toBeGreaterThanOrEqual(120);
  });

  it('tells the operator to set the secrets, and does not set them', () => {
    expect(flyRaw).toMatch(/fly secrets set DATABASE_URL=.* SECRET_KEY=.* SETUP_CODE=/);
  });

  it('keeps one machine up, because the volume and the in-process scheduler allow only one', () => {
    expect(flyRaw).toMatch(/^\s*min_machines_running = 1$/m);
    expect(flyRaw).toMatch(/^\s*auto_stop_machines = "off"$/m);
  });
});

describe('railway.json', () => {
  const railway = JSON.parse(railwayRaw) as {
    build: { builder: string; dockerfilePath: string };
    deploy: { numReplicas: number; healthcheckPath: string };
  };

  it('builds from a Dockerfile that is nothing but the published slim image', () => {
    expect(railway.build.builder).toBe('DOCKERFILE');
    expect(existsSync(resolve(root, railway.build.dockerfilePath))).toBe(true);
    const dockerfile = read(railway.build.dockerfilePath)
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(dockerfile).toHaveLength(1);
    expect(dockerfile[0]).toMatch(/^FROM contextator\/contextator:[\w.]+-slim$/);
  });

  it('runs one replica and checks /api/health', () => {
    expect(railway.deploy.numReplicas).toBe(1);
    expect(railway.deploy.healthcheckPath).toBe('/api/health');
  });
});

describe('docs/deployment.md', () => {
  const doc = read('docs/deployment.md');
  const section = (heading: string): string => {
    const start = doc.indexOf(`### ${heading}`);
    expect(start, `no "### ${heading}" section`).toBeGreaterThan(-1);
    const next = doc.indexOf('\n#', start + 1);
    return doc.slice(start, next === -1 ? undefined : next);
  };

  it.each([
    ['Railway', 'deploy/railway/railway.json'],
    ['Render', 'deploy/render/render.yaml'],
    ['Fly.io', 'deploy/fly/fly.toml'],
  ])('has click-to-deploy steps for %s that name the template file', (heading, file) => {
    const body = section(heading);
    expect(body).toContain(file);
    expect(existsSync(resolve(root, file))).toBe(true);
    expect(body).toMatch(/^\s*(1\.|```bash)/m);
  });

  it('says the templates publish the port, that projects are born token-protected, and that SETUP_CODE and SECRET_KEY are needed', () => {
    const body = doc.slice(doc.indexOf('## One-click templates'));
    expect(body).toMatch(/publish the port to the internet/);
    expect(body).toMatch(/born token-protected/);
    expect(body).toContain('SETUP_CODE');
    expect(body).toContain('SECRET_KEY');
    expect(body).toMatch(/non-loopback address/);
  });

  it('is linked from CONTRIBUTING.md through the deploy directory', () => {
    expect(read('CONTRIBUTING.md')).toContain('deploy/');
  });
});
