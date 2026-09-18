import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requirePrincipal } from '../auth/plugin.js';
import { canActOnRole, roleAtLeast } from '../auth/policy.js';
import { ForbiddenError } from '../services/errors.js';
import { NotFoundError } from '../services/projects.js';
import { assertPasswordAcceptable, generateTempPassword } from '../services/passwords.js';
import { countActiveSessions, revokeSessionsOfUser } from '../services/auth/sessions.js';
import { createUser, deleteUser, getUserById, listUsers, setPassword, toUserView, updateUser } from '../services/auth/users.js';

const IdParams = z.object({ id: z.uuid() });
const Role = z.enum(['root', 'admin', 'member']);

const CreateBody = z.object({
  username: z.string().min(2).max(63),
  displayName: z.string().max(100).optional(),
  email: z.string().max(200).nullable().optional(),
  role: Role.default('member'),
  /** Omitted means "generate one and show it to me once". */
  password: z.string().min(1).max(1024).optional(),
  mustChangePassword: z.boolean().default(true),
});

const UpdateBody = z.object({
  displayName: z.string().max(100).optional(),
  email: z.string().max(200).nullable().optional(),
  role: Role.optional(),
  isActive: z.boolean().optional(),
});

const PasswordBody = z.object({ password: z.string().min(1).max(1024).optional() });

/**
 * `/api/users/*` — root and admin only (enforced by the policy table, not here).
 *
 * The rules this file does enforce are the ones the policy table cannot see, because they depend on
 * the *target*: an admin may not touch a root account, and nobody may disable, demote or delete
 * themselves. The "last root" rule lives one layer down, in services/auth/users.ts, where it can
 * hold a transaction open.
 */
export const usersRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { config, db, log } = ctx;

  const requireTarget = async (id: string) => {
    const target = await getUserById(db, id);
    if (!target) throw new NotFoundError('User not found');
    return target;
  };

  /** An admin can see a root account but never change one; only another root can. */
  const assertMayTouch = (actorRole: 'root' | 'admin' | 'member', targetRole: 'root' | 'admin' | 'member') => {
    if (targetRole === 'root' && actorRole !== 'root') {
      throw new ForbiddenError('forbidden', 'Only a root account can change another root account');
    }
  };

  const assertNotSelf = (actorId: string | null, targetId: string, what: string) => {
    if (actorId && actorId === targetId) throw new ForbiddenError('forbidden', `You cannot ${what} yourself`);
  };

  app.get('/api/users', async () => {
    const views = await listUsers(db);
    return Promise.all(views.map(async (v) => ({ ...v, activeSessionCount: await countActiveSessions(db, v.id, config.AUTH_SESSION_IDLE_MS) })));
  });

  app.post('/api/users', async (req, reply) => {
    const principal = requirePrincipal(req);
    const body = CreateBody.parse(req.body);
    if (!canActOnRole(principal, body.role)) throw new ForbiddenError('forbidden', 'Only a root account can create another root account');

    const generated = body.password ? null : generateTempPassword();
    const password = body.password ?? generated!;
    assertPasswordAcceptable(password, { minLength: config.PASSWORD_MIN_LENGTH, username: body.username });

    const row = await createUser(db, {
      username: body.username,
      password,
      role: body.role,
      displayName: body.displayName,
      email: body.email ?? null,
      mustChangePassword: body.mustChangePassword,
      createdBy: principal.userId,
    });
    log.info({ username: row.username, role: row.role, by: principal.username }, 'user created');
    // The generated password is shown once, here, and never stored in the clear anywhere.
    return reply.code(201).send({ user: toUserView(row), temporaryPassword: generated });
  });

  app.get('/api/users/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const target = await requireTarget(id);
    return { user: toUserView(target), activeSessionCount: await countActiveSessions(db, id, config.AUTH_SESSION_IDLE_MS) };
  });

  app.patch('/api/users/:id', async (req) => {
    const principal = requirePrincipal(req);
    const { id } = IdParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    const target = await requireTarget(id);

    assertMayTouch(principal.role, target.role);
    if (body.role !== undefined && body.role !== target.role) {
      if (!canActOnRole(principal, body.role)) throw new ForbiddenError('forbidden', 'Only a root account can grant the root role');
      assertNotSelf(principal.userId, id, 'change the role of');
    }
    if (body.isActive === false) assertNotSelf(principal.userId, id, 'disable');

    const row = await updateUser(db, id, body);
    // The role is read from the database on every request, so a change already applies to the
    // sessions this account has open. Ending them anyway is what an operator expects when someone
    // loses standing — but a promotion is no reason to throw them out of the dashboard.
    const demoted = body.role !== undefined && !roleAtLeast(body.role, target.role);
    if (body.isActive === false || demoted) await revokeSessionsOfUser(db, id);
    return toUserView(row);
  });

  app.post('/api/users/:id/password', async (req) => {
    const principal = requirePrincipal(req);
    const { id } = IdParams.parse(req.params);
    const body = PasswordBody.parse(req.body ?? {});
    const target = await requireTarget(id);
    assertMayTouch(principal.role, target.role);

    const generated = body.password ? null : generateTempPassword();
    const password = body.password ?? generated!;
    assertPasswordAcceptable(password, { minLength: config.PASSWORD_MIN_LENGTH, username: target.username });

    await setPassword(db, id, password, true); // they must replace it at the next sign-in
    await revokeSessionsOfUser(db, id);
    log.info({ username: target.username, by: principal.username }, 'password reset by an administrator');
    return { temporaryPassword: generated };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = IdParams.parse(req.params);
    const target = await requireTarget(id);
    assertMayTouch(principal.role, target.role);
    assertNotSelf(principal.userId, id, 'delete');
    await deleteUser(db, id); // sessions and memberships cascade
    log.info({ username: target.username, by: principal.username }, 'user deleted');
    return reply.code(204).send();
  });

  app.delete('/api/users/:id/sessions', async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = IdParams.parse(req.params);
    const target = await requireTarget(id);
    assertMayTouch(principal.role, target.role);
    await revokeSessionsOfUser(db, id);
    return reply.code(204).send();
  });
};
