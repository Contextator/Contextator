import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DocumentSourceRow } from '../db/schema.js';
import type { ImportStats } from '../services/archives.js';
import { assertDiskSpace } from '../services/disk-space.js';
import { QuotaExceededError, QuotaUsageUnavailableError } from '../services/errors.js';
import { ConflictError, NotFoundError, ValidationError, getProjectById } from '../services/projects.js';
import { projectUploadBytes, resolveQuotas } from '../services/quotas.js';
import { getSource } from '../services/sources.js';
import type { UploadQuota, UploadRequestQuota } from '../services/uploads.js';

/**
 * Discards whatever is left of a part so the multipart stream can continue with the next one.
 * An archive is streamed to disk *before* it is unpacked, so a failure there leaves a part that has
 * already ended: attaching `end` to it would never fire again and the request would hang forever.
 */
export async function drainPart(file: NodeJS.ReadableStream): Promise<void> {
  const stream = file as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
  if (stream.readableEnded || stream.destroyed) return;
  await new Promise<void>((resolve) => {
    stream
      .on('end', resolve)
      .on('error', () => resolve())
      .resume();
  });
}

const SourceParams = z.object({ id: z.uuid(), sid: z.uuid() });
const SessionParams = SourceParams.extend({ session: z.string().regex(/^[0-9a-f]{32}$/) });
const CommitQuery = z.object({ mode: z.enum(['add', 'replace']).default('add') });
const FileQuery = z.object({ path: z.string().min(1).max(2048) });

/**
 * Upload endpoints for `upload` sources. The multipart parser is registered only in this child plugin,
 * so other admin routes keep rejecting multipart bodies. Nested in adminRoutes → ADMIN_TOKEN applies.
 */
export const uploadRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config, indexer, locks, uploads } = ctx;

  await app.register(multipart, {
    // Browsers put only the basename in `filename`; the dashboard sends the relative path there instead.
    preservePath: true,
    limits: {
      fileSize: Math.max(config.UPLOAD_MAX_FILE_BYTES, config.UPLOAD_MAX_ARCHIVE_BYTES),
      files: config.UPLOAD_MAX_FILES_PER_REQUEST,
      fields: 10,
    },
  });

  const requireUploadSource = async (id: string, sid: string): Promise<DocumentSourceRow> => {
    if (!(await getProjectById(db, id))) throw new NotFoundError('Project not found');
    const source = await getSource(db, id, sid);
    if (!source) throw new NotFoundError('Source not found');
    if (source.type !== 'upload') throw new ValidationError('Files can only be uploaded to an "upload" source');
    return source;
  };

  /**
   * The upload quota that applies to this project right now, or `undefined` when it has none
   * ([ADR-0117](../../.ssot/ADR.md#adr-0117)). An unlimited project skips the directory scan entirely. When
   * the scan fails the error propagates and the request is refused with `503`: usage nobody could measure
   * is not "under the limit".
   */
  const loadUploadQuota = async (projectId: string): Promise<UploadQuota | undefined> => {
    const project = await getProjectById(db, projectId);
    if (!project) throw new NotFoundError('Project not found');
    const { limit } = resolveQuotas(project, config).uploadBytes;
    if (limit === 0) return undefined;
    return { limit, used: await projectUploadBytes(db, config.DATA_DIR, projectId) };
  };

  app.post('/api/projects/:id/sources/:sid/uploads', async (req, reply) => {
    const { id, sid } = SourceParams.parse(req.params);
    const source = await requireUploadSource(id, sid);
    await assertDiskSpace(config.DATA_DIR, config.DATA_DIR_MIN_FREE_BYTES);
    return reply.code(201).send({ session: await uploads.createSession(source, await loadUploadQuota(id)) });
  });

  app.post('/api/projects/:id/sources/:sid/uploads/:session/files', async (req) => {
    const { id, sid, session } = SessionParams.parse(req.params);
    const source = await requireUploadSource(id, sid);
    // Checked per request and not only when the session opens: a folder upload is many requests, and the
    // disk can fill between the first and the last. Refused before a byte of this request is written.
    await assertDiskSpace(config.DATA_DIR, config.DATA_DIR_MIN_FREE_BYTES);
    const quota = await loadUploadQuota(id);
    const tracker: UploadRequestQuota | undefined = quota ? await uploads.beginRequest(source, session, quota) : undefined;
    const totals: ImportStats = { files: 0, skipped: 0, bytes: 0 };
    const errors: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      try {
        const s = await uploads.addFile(source, session, part.filename, part.file, tracker);
        totals.files += s.files;
        totals.skipped += s.skipped;
        totals.bytes += s.bytes;
      } catch (err) {
        await drainPart(part.file);
        // A quota refusal ends the request instead of joining `errors`: the caller must see 413, and the
        // files this request already stored are taken back so a refused request leaves nothing behind.
        if (err instanceof QuotaExceededError && tracker) await uploads.rollbackRequest(tracker);
        if (err instanceof QuotaExceededError || err instanceof QuotaUsageUnavailableError) throw err;
        errors.push(`${part.filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ...totals, errors };
  });

  app.post('/api/projects/:id/sources/:sid/uploads/:session/commit', async (req, reply) => {
    const { id, sid, session } = SessionParams.parse(req.params);
    const { mode } = CommitQuery.parse(req.query);
    const source = await requireUploadSource(id, sid);
    if (indexer.isBusy(id)) throw new ConflictError('Project is currently being indexed; commit the upload when it finishes');
    const files = await locks.runExclusive(id, async () => uploads.commit(source, session, mode, await loadUploadQuota(id)));
    const job = indexer.enqueue(id);
    return reply.code(202).send({ files, job });
  });

  app.delete('/api/projects/:id/sources/:sid/uploads/:session', async (req, reply) => {
    const { id, sid, session } = SessionParams.parse(req.params);
    const source = await requireUploadSource(id, sid);
    await uploads.abort(source, session);
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/sources/:sid/files', async (req) => {
    const { id, sid } = SourceParams.parse(req.params);
    const source = await requireUploadSource(id, sid);
    return { files: await uploads.listFiles(source) };
  });

  app.delete('/api/projects/:id/sources/:sid/files', async (req, reply) => {
    const { id, sid } = SourceParams.parse(req.params);
    const { path: relativePath } = FileQuery.parse(req.query);
    const source = await requireUploadSource(id, sid);
    if (indexer.isBusy(id)) throw new ConflictError('Project is currently being indexed; try again when it finishes');
    await locks.runExclusive(id, () => uploads.deleteFile(source, relativePath));
    indexer.enqueue(id);
    return reply.code(204).send();
  });
};
