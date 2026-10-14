import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_NAME = 200;
const MAX_THUMBNAIL = 512 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid design id');
  return id;
}

function validateBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON body');
  const { name, data, thumbnail } = body;
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required');
  if (name.length > MAX_NAME) throw new HttpError(400, `name must be at most ${MAX_NAME} characters`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'data must be an object');
  for (const key of ['nodes', 'walls', 'openings', 'rooms']) {
    if (!Array.isArray(data[key])) throw new HttpError(400, `data.${key} must be an array`);
  }
  if (thumbnail != null && (typeof thumbnail !== 'string' || thumbnail.length > MAX_THUMBNAIL)) {
    throw new HttpError(400, 'thumbnail must be a string under 512 KB');
  }
  return { name: name.trim(), data, thumbnail: thumbnail ?? null };
}

export function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  const api = express.Router();

  api.get('/designs', (req, res) => {
    res.json(store.list());
  });

  api.get('/designs/:id', (req, res) => {
    const design = store.get(parseId(req.params.id));
    if (!design) throw new HttpError(404, 'Design not found');
    res.json(design);
  });

  api.post('/designs', (req, res) => {
    res.status(201).json(store.create(validateBody(req.body)));
  });

  api.put('/designs/:id', (req, res) => {
    const updated = store.update(parseId(req.params.id), validateBody(req.body));
    if (!updated) throw new HttpError(404, 'Design not found');
    res.json(updated);
  });

  api.delete('/designs/:id', (req, res) => {
    if (!store.remove(parseId(req.params.id))) throw new HttpError(404, 'Design not found');
    res.status(204).end();
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}
