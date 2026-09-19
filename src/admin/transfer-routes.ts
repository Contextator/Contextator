import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { NotFoundError, ValidationError, getProjectById } from '../services/projects.js';
import { exportProject } from '../services/transfer/export.js';
import { importProject } from '../services/transfer/import.js';
import { drainPart } from './upload-routes.js';

/**
 * Moving one project between instances ([ADR-0051](../../.ssot/ADR.md#adr-0051)).
 *
 * Two routes, and neither is an editor's:
 *
 * - **`GET /api/projects/:id/export` is a `manager`'s.** It is a read of *everything* in the project at
 *   once — every document's stored text, every chunk, every source's settings — written to a file that
 *   leaves the instance. A `viewer` can already read any one of those through the dashboard, which is
 *   the argument for the `GET` default; what the default cannot see is that the whole corpus in one
 *   downloadable artefact is a different act from reading a page of it, and it is the same class of
 *   decision as `PATCH /api/projects/:id/mcp-auth` — who may see this project's content, and where.
 * - **`POST /api/projects/import` is an instance `admin`'s**, and it is not project-scoped at all:
 *   there is no project to be a member of yet. It *creates* one, which
 *   [ADR-0028](../../.ssot/ADR.md#adr-0028) already made admin-only for `POST /api/projects` — a new
 *   `/mcp/<name>` surface, disk and CPU — and this one additionally writes into `DATA_DIR` from a file
 *   somebody uploaded.
 *
 * The multipart parser is registered in this child plugin only, exactly as `upload-routes.ts` registers
 * its own, so every other admin route keeps rejecting multipart bodies.
 */

const IdParams = z.object({ id: z.uuid() });

/** `name` is how a collision with an existing project is resolved, and how a second copy is made. */
const ImportFields = z.object({ name: z.string().min(1).max(63).optional() });

export const transferRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config, embeddings } = ctx;

  await app.register(multipart, {
    limits: {
      // An export of a real corpus is large, and it is one file. The archive cap is the one an
      // operator already sizes for uploads.
      fileSize: config.UPLOAD_MAX_ARCHIVE_BYTES,
      files: 1,
      fields: 5,
    },
  });

  app.get('/api/projects/:id/export', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const project = await getProjectById(db, id);
    if (!project) throw new NotFoundError('Project not found');

    const result = await exportProject({ db, config, product: { name: 'contextator', version: ctx.version } }, project);
    req.log.info({ projectId: id, generation: result.manifest.project.exportedGeneration, counts: result.manifest.counts }, 'exported a project');

    // The staging directory outlives this handler by exactly as long as the stream does. `close` on the
    // raw response covers the client that disconnects halfway, which is the case a `finally` here misses.
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      void result.cleanup();
    };
    result.stream.on('end', finish).on('error', finish);
    reply.raw.on('close', finish);

    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${result.filename}"`)
      .send(result.stream);
  });

  app.post('/api/projects/import', async (req, reply) => {
    // One archive per request, streamed to a scratch file before anything looks inside it: the
    // manifest cannot be trusted to describe the bytes, so the bytes arrive first and are bounded by
    // the multipart limit above rather than by what the archive claims.
    const scratch = path.join(os.tmpdir(), `contextator-import-${randomUUID()}.tar.gz`);
    let archive = false;
    const fields: Record<string, string> = {};

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (typeof part.value === 'string') fields[part.fieldname] = part.value;
          continue;
        }
        if (archive) {
          await drainPart(part.file);
          continue;
        }
        await pipeline(part.file, createWriteStream(scratch));
        if (part.file.truncated) {
          throw new ValidationError(`The uploaded file is larger than UPLOAD_MAX_ARCHIVE_BYTES (${config.UPLOAD_MAX_ARCHIVE_BYTES} bytes).`);
        }
        archive = true;
      }
      if (!archive) throw new ValidationError('Attach the .tar.gz produced by GET /api/projects/:id/export as a file part.');

      const { name } = ImportFields.parse(fields);
      const report = await importProject({ db, config, embeddings }, scratch, name);
      req.log.info(
        { projectId: report.projectId, documents: report.documents, chunks: report.chunks, from: report.manifest.instance.id },
        'imported a project',
      );
      return reply.code(201).send(report);
    } finally {
      await fs.rm(scratch, { force: true }).catch(() => undefined);
    }
  });
};
