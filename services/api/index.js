import app from './app.js';
import { migrate } from './db/migrate.js';

const PORT = process.env.PORT || 8080;

(async () => {
  try {
    if (process.env.DATABASE_URL) {
      await migrate();
    } else {
      console.warn('DATABASE_URL not set; starting without DB migrations');
    }
    app.listen(PORT, () => console.log(`API listening on ${PORT}`));
  } catch (e) {
    console.error('Startup failed', e);
    process.exit(1);
  }
})();

