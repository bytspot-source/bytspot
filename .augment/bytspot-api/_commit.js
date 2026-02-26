const cp = require('child_process');
const opts = { cwd: 'C:\\Users\\godmo', stdio: 'inherit' };
cp.execSync('git add .augment/bytspot-api/', opts);
cp.execSync('git commit -m "feat: add PostGIS + pgvector extensions with geo-query and similarity routes"', opts);
cp.execSync('git push origin beta-funnel/deploy', opts);
