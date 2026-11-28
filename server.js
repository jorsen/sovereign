const app = require('./lib/app');
const { ensureSchema } = require('./lib/db');

// 3001 locally: Capital Records uses 3000 on the same PC.
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Sovereign running at http://localhost:${PORT}`);
  // The database setup is many queries the first time (the database is in
  // US East): run it now instead of making the first visitor wait for it.
  const started = Date.now();
  ensureSchema()
    .then(() => console.log(`Database ready (${((Date.now() - started) / 1000).toFixed(1)}s).`))
    .catch((err) => console.error('Database setup failed:', err.message));
});
