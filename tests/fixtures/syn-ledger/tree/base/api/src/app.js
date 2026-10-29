import express from 'express';
import { pool } from './db.js';
import { registerJobs } from './loader.js';
import { routes } from './routes/index.js';
import { requireSession } from './session.js';

const app = express();

app.use(express.json());
app.use((req, res, next) => {
  try {
    req.session = requireSession(req);
    next();
  } catch (error) {
    next(error);
  }
});
app.use(routes);
app.use((error, req, res, next) => {
  res.status(error.status ?? 500).json({ error: error.expose ? error.message : 'internal error' });
});

registerJobs(pool);
app.listen(Number(process.env.PORT ?? 8080));
